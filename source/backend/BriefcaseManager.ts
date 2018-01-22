/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2017 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import { AccessToken, Briefcase as HubBriefcase, IModelHubClient, ChangeSet, IModel as ConnectIModel, ContainsSchemaChanges, SeedFile, SeedFileInitState } from "@bentley/imodeljs-clients";
import { ChangeSetProcessOption } from "@bentley/bentleyjs-core/lib/Bentley";
import { BeEvent } from "@bentley/bentleyjs-core/lib/BeEvent";
import { DbResult, OpenMode } from "@bentley/bentleyjs-core/lib/BeSQLite";
import { assert } from "@bentley/bentleyjs-core/lib/Assert";
import { Logger } from "@bentley/bentleyjs-core/lib/Logger";
import { BriefcaseStatus, IModelError } from "../common/IModelError";
import { IModelVersion } from "../common/IModelVersion";
import { IModelToken, Configuration } from "../common/IModel";
import { NodeAddonRegistry } from "./NodeAddonRegistry";
import { NodeAddonDgnDb, ErrorStatusOrResult, NodeAddonBriefcaseManagerResourcesRequest } from "@bentley/imodeljs-nodeaddonapi/imodeljs-nodeaddonapi";
import { IModelDb } from "./IModelDb";

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** The ID assigned to a briefcase by iModelHub, or one of the special values that identify special kinds of iModels */
export class BriefcaseId {
  private value: number;
  public static get Illegal(): number { return 0xffffffff; }
  public static get Master(): number { return 0; }
  public static get Standalone(): number { return 1; }
  constructor(value?: number) {
    if (value === undefined)
      this.value = BriefcaseId.Illegal;
    else this.value = value;
  }
  public isValid(): boolean { return this.value !== BriefcaseId.Illegal; }
  public isMaster(): boolean { return this.value !== BriefcaseId.Master; }
  public isStandaloneId(): boolean { return this.value !== BriefcaseId.Standalone; }
  public getValue(): number { return this.value; }
  public toString(): string { return this.value.toString(); }
}

/** Option to keep briefcase when the imodel is closed */
export const enum KeepBriefcase {
  No = 0,
  Yes = 1,
}

/** A token that represents a ChangeSet  */
class ChangeSetToken {
  constructor(public id: string, public parentId: string, public index: number, public pathname: string, public containsSchemaChanges: ContainsSchemaChanges) { }
}

/** Entry in the briefcase cache */
export class BriefcaseEntry {
  /** Id of the iModel - set to the DbGuid field in the BIM, it corresponds to the Guid used to track the iModel in iModelHub */
  public iModelId: string;

  /** Id of the last change set that was applied to the BIM. Set to an empty string if it's the initial version, or a standalone briefcase */
  public changeSetId: string;

  /** Index of the change set - only specified if the briefcase was acquired from the Hub. Set to 0 if there are no change sets - it's the initial version */
  public changeSetIndex?: number;

  /** Briefcase Id  */
  public briefcaseId: number;

  /** Local path name where the briefcase is cached */
  public pathname: string;

  /** Mode used to open the iModel */
  public openMode: OpenMode;

  /** Flag to indicate if the briefcase is currently open */
  public isOpen: boolean;

  /** Id of the user that acquired the briefcase. This is not set if it's standalone briefcase */
  public userId?: string;

  /** In-memory handle of the native Db */
  public nativeDb: NodeAddonDgnDb;

  /** In-memory handle fo the IModelDb that corresponds with this briefcase. This is only set if an IModelDb wrapper has been created for this briefcase */
  public iModelDb?: IModelDb;

  /** File Id used to upload change sets for this briefcase (only setup in Read-Write cases) */
  public fileId?: string;

  /** Event called when the briefcase is about to be closed */
  public readonly onClose = new BeEvent<() => void>();

  /** Event called when the version of the briefcase has been updated */
  public readonly onVersionUpdated = new BeEvent<() => void>();
}

/** In-memory cache of briefcases */
class BriefcaseCache {
  private readonly briefcases = new Map<string, BriefcaseEntry[]>(); // Indexed by iModelId

  /** Add a briefcase to the cache */
  public addBriefcase(briefcase: BriefcaseEntry) {
    const existingBriefcase = this.findBriefcaseByToken({ iModelId: briefcase.iModelId, changeSetId: briefcase.changeSetId, userId: briefcase.userId, openMode: briefcase.openMode });
    if (!!existingBriefcase) {
      // Note: Perhaps this was a merge gone bad?
      Logger.logError(`Briefcase for iModel with iModelId=${briefcase.iModelId}, changeSetId=${briefcase.changeSetId} and userId=${briefcase.userId} already exists in the cache.`);
      throw new IModelError(DbResult.BE_SQLITE_ERROR);
    }

    let iModelBriefcases = this.getIModelBriefcases(briefcase.iModelId);
    if (!iModelBriefcases) {
      iModelBriefcases = new Array<BriefcaseEntry>();
      this.briefcases.set(briefcase.iModelId, iModelBriefcases);
    }
    iModelBriefcases.push(briefcase);
  }

  /** Get all briefcases for an imodel */
  public getIModelBriefcases(iModelId: string): BriefcaseEntry[] | undefined {
    return this.briefcases.get(iModelId);
  }

  /** Get all entries in the cache */
  public getFilteredBriefcases(filterFn: (value: BriefcaseEntry) => boolean): BriefcaseEntry[] {
    const allBriefcases = new Array<BriefcaseEntry>();
    for (const modelEntries of this.briefcases.values()) {
      allBriefcases.concat(modelEntries.filter(filterFn));
    }
    return allBriefcases;
  }

  /** Find a briefcase in the cache by token */
  public findBriefcaseByToken({ iModelId, changeSetId, userId, openMode }: IModelToken): BriefcaseEntry | undefined {
    const iModelBriefcases = this.getIModelBriefcases(iModelId);
    if (!iModelBriefcases)
      return undefined;

    const foundBriefcase: BriefcaseEntry | undefined = iModelBriefcases.find((briefcase: BriefcaseEntry) => {
      if (openMode === OpenMode.Readonly)
        return briefcase.changeSetId === changeSetId;

      return briefcase.changeSetId === changeSetId && briefcase.userId === userId;
    });

    if (!!foundBriefcase)
      assert(foundBriefcase.openMode === openMode, "Error locating the briefcase with the correct mode");

    return foundBriefcase;
  }

  /** Find a briefcase in the cache */
  public findBriefcase(briefcase: BriefcaseEntry): BriefcaseEntry | undefined {
    const entries = this.getIModelBriefcases(briefcase.iModelId);
    if (!entries)
      return undefined;

    return entries.find((value: BriefcaseEntry) => value.pathname === briefcase.pathname);
  }

  /** Remove a briefcase from the cache */
  public deleteBriefcase(briefcase: BriefcaseEntry) {
    const entries = this.getIModelBriefcases(briefcase.iModelId);
    if (!entries) {
      throw new Error("Briefcase not found in cache");
    }

    const index = entries.findIndex((value: BriefcaseEntry) => value.pathname === briefcase.pathname);
    if (index < 0) {
      throw new Error("Briefcase not found in cache");
    }
    entries.splice(index, 1);

    if (entries.length === 0) {
      this.briefcases.delete(briefcase.iModelId);
    }
  }

}

/** Utility to manage briefcases
 * @description
 * Folder structure for cached imodels:
 *  /assets/imodels/                => cachePath (can be specified)
 *    iModelId1/                    => iModelPath
 *      csets/                      => csetPath
 *        csetId1.cs
 *        csetid2.cs
 *        ...
 *      readOnly/
 *        0/IModelName.bim
 *        1/IModelName.bim
 *        ...
 *      readWrite/
 *        briefcaseId1/IModelName.bim
 *        briefcaseId2/IModelName.bim
 *        ...
 *    iModelId2/
 *      ...
 */
export class BriefcaseManager {
  public static hubClient?: IModelHubClient;
  private static cache?: BriefcaseCache;

  /** The path where the cache of briefcases are stored. */
  public static cachePath = path.join(os.tmpdir(), "Bentley/IModelJs/cache/imodels");

  /** Get the local path of the root folder storing the imodel seed file, change sets and briefcases */
  private static getIModelPath(iModelId: string): string {
    return path.join(BriefcaseManager.cachePath, iModelId);
  }

  public static getChangeSetsPath(iModelId: string): string {
    return path.join(BriefcaseManager.getIModelPath(iModelId), "csets");
  }

  public static buildChangeSummaryFilePath(iModelId: string): string {
    return path.join(BriefcaseManager.getIModelPath(iModelId), iModelId.concat(".bim.ecchanges"));
  }

  private static buildReadOnlyPath(iModelId: string, iModelName: string): string {
    const briefcases = BriefcaseManager.cache!.getIModelBriefcases(iModelId);
    const numReadonly = !briefcases ? 0 : briefcases.reduce((total, briefcase) => briefcase.openMode === OpenMode.Readonly ? total + 1 : total, 0);
    return path.join(BriefcaseManager.getIModelPath(iModelId), "readOnly", numReadonly.toString(), iModelName.concat(".bim"));
  }

  private static buildReadWritePath(iModelId: string, briefcaseId: number, iModelName: string): string {
    return path.join(BriefcaseManager.getIModelPath(iModelId), "readWrite", briefcaseId.toString(), iModelName.concat(".bim"));
  }

  /** Get information on the briefcases that have been cached on disk
   * @description Format of returned JSON:
   *  {
   *    "iModelId1": [
   *      {
   *        "pathname": "path to imodel",
   *        "parentChangeSetId": "Id of parent change set",
   *        "briefcaseId": "Id of brief case. Standalone if it's a readonly standalone briefcase.",
   *        "readOnly": true or false
   *      },
   *      {
   *        ...
   *      },
   *    ],
   *    "iModelId2": [
   *      ...
   *    ]
   * }
   */
  private static getCachedBriefcaseInfos(): any {
    const nativeDb: NodeAddonDgnDb = new (NodeAddonRegistry.getAddon()).NodeAddonDgnDb();
    const res: ErrorStatusOrResult<DbResult, string> = nativeDb.getCachedBriefcaseInfos(BriefcaseManager.cachePath);
    if (res.error)
      Promise.reject(new IModelError(res.error.status));

    return JSON.parse(res.result!);
  }

  /** Initialize the briefcase manager. This hydrates a cache of in-memory briefcases if necessary. */
  public static async initialize(accessToken?: AccessToken): Promise<void> {
    if (BriefcaseManager.cache) {
      if (BriefcaseManager.hubClient!.deploymentEnv === Configuration.iModelHubDeployConfig)
        return;
      Logger.logWarning("Detected change of configuration: re-initializing Briefcase cache!");
    }

    const startTime = new Date().getTime();

    BriefcaseManager.hubClient = new IModelHubClient(Configuration.iModelHubDeployConfig);
    BriefcaseManager.cache = new BriefcaseCache();
    if (!accessToken)
      return;

    const briefcaseInfos = BriefcaseManager.getCachedBriefcaseInfos();

    const iModelIds = Object.getOwnPropertyNames(briefcaseInfos);
    for (const iModelId of iModelIds) {
      const localBriefcases = briefcaseInfos[iModelId];

      let hubBriefcases: HubBriefcase[]|undefined;

      for (const localBriefcase of localBriefcases) {
        const briefcase = new BriefcaseEntry();
        briefcase.iModelId = iModelId;
        briefcase.changeSetId = localBriefcase.parentChangeSetId;
        briefcase.briefcaseId = localBriefcase.briefcaseId;
        briefcase.pathname = localBriefcase.pathname;
        briefcase.openMode = localBriefcase.readOnly ? OpenMode.Readonly : OpenMode.ReadWrite;
        briefcase.isOpen = false;

        try {
          if (!localBriefcase.readOnly) {
            if (!hubBriefcases)
              hubBriefcases = await BriefcaseManager.hubClient.getBriefcases(accessToken, iModelId);

            const hubBriefcase = hubBriefcases.find((bc: HubBriefcase) => bc.briefcaseId === localBriefcase.briefcaseId);
            if (!hubBriefcase) {
              throw new IModelError(DbResult.BE_SQLITE_ERROR);
            }
            briefcase.userId = hubBriefcase.userId;
            briefcase.fileId = hubBriefcase.fileId;
          }

          briefcase.changeSetIndex = await BriefcaseManager.getChangeSetIndexFromId(accessToken, iModelId, briefcase.changeSetId);

          // briefcase.nativeDb = undefined;
          BriefcaseManager.cache.addBriefcase(briefcase);
        } catch (error) {
          // The iModel is unreachable on the hub - deployment configuration is different, imodel was removed, the current user does not have access
          Logger.logWarning(`Unable to find briefcase ${briefcase.iModelId}:${briefcase.briefcaseId} on the Hub. Deleting it`);
          await BriefcaseManager.deleteBriefcase(accessToken, briefcase);
          continue;
        }
      }
    }

    // TODO: Temporary logging for resolving potential performance issue with briefcase manager initialization
    console.log(`    ...initialization of briefcase cache: ${new Date().getTime() - startTime} ms`); // tslint:disable-line:no-console
  }

  /** Get the index of the change set from it's id */
  private static async getChangeSetIndexFromId(accessToken: AccessToken, iModelId: string, changeSetId: string): Promise<number> {
    if (changeSetId === "")
      return 0; // the first version
    try {
      const changeSet: ChangeSet = await BriefcaseManager.hubClient!.getChangeSet(accessToken, iModelId, false, changeSetId);
      return +changeSet.index;
    } catch (err) {
      assert(false, "Could not determine index of change set");
      return -1;
    }
  }

  /** Open a briefcase */
  public static async open(accessToken: AccessToken, projectId: string, iModelId: string, openMode: OpenMode, version: IModelVersion): Promise<BriefcaseEntry> {
    await BriefcaseManager.initialize(accessToken);
    assert(!!BriefcaseManager.hubClient);

    const changeSetId: string = await version.evaluateChangeSet(accessToken, iModelId);

    let changeSetIndex: number;
    if (changeSetId === "") {
      changeSetIndex = 0; // First version
    } else {
      const changeSet: ChangeSet = await BriefcaseManager.getChangeSetFromId(accessToken, iModelId, changeSetId);
      changeSetIndex = changeSet ? +changeSet.index : 0;
    }

    let briefcase = BriefcaseManager.findCachedBriefcase(accessToken, iModelId, openMode, changeSetIndex);
    if (briefcase && briefcase.isOpen) {
      assert(briefcase.changeSetIndex === changeSetIndex);
      return briefcase;
    }

    if (!briefcase)
      briefcase = await BriefcaseManager.createBriefcase(accessToken, projectId, iModelId, openMode);
    else if (!briefcase.isOpen)
      BriefcaseManager.openBriefcase(briefcase);

    await BriefcaseManager.pullAndMergeChanges(accessToken, briefcase, IModelVersion.asOfChangeSet(changeSetId));

    return briefcase;
  }

  /** Close a briefcase */
  public static async close(accessToken: AccessToken, briefcase: BriefcaseEntry, keepBriefcase: KeepBriefcase): Promise<void> {
    briefcase.onClose.raiseEvent(briefcase);
    briefcase.nativeDb!.closeDgnDb();
    briefcase.isOpen = false;
    if (keepBriefcase === KeepBriefcase.No)
      await BriefcaseManager.deleteBriefcase(accessToken, briefcase);
  }

  /** Get the change set from the specified id */
  private static async getChangeSetFromId(accessToken: AccessToken, iModelId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSets: ChangeSet[] = await BriefcaseManager.hubClient!.getChangeSets(accessToken, iModelId, false /*=includeDownloadLink*/);
    // todo: pass the last known highest change set id to improve efficiency, and cache the results also.

    for (const changeSet of changeSets) {
      if (changeSet.wsgId === changeSetId)
        return changeSet;
    }

    return Promise.reject(new IModelError(BriefcaseStatus.VersionNotFound));
  }

  /** Finds any existing briefcase for the specified parameters. Pass null for the requiredChangeSet if the first version is to be retrieved */
  private static findCachedBriefcase(accessToken: AccessToken, iModelId: string, openMode: OpenMode, requiredChangeSetIndex: number): BriefcaseEntry|undefined {

    // Narrow the cache down to the entries for the specified imodel and openMode
    let briefcases: BriefcaseEntry[] | undefined = BriefcaseManager.cache!.getIModelBriefcases(iModelId);
    if (briefcases)
      briefcases = briefcases.filter((entry: BriefcaseEntry) => entry.openMode === openMode);
    if (!briefcases || briefcases.length === 0)
      return undefined;

    // For read-only cases...
    let briefcase: BriefcaseEntry | undefined;
    if (openMode === OpenMode.Readonly) {

      // first prefer any standalone briefcase that's open, and with changeSetIndex = requiredChangeSetIndex
      briefcase = briefcases.find((entry: BriefcaseEntry): boolean => {
        return entry.briefcaseId === BriefcaseId.Standalone && entry.isOpen && entry.changeSetIndex === requiredChangeSetIndex && entry.briefcaseId === BriefcaseId.Standalone;
      });
      if (briefcase)
        return briefcase;

      // next prefer any standalone briefcase that's closed, and with changeSetIndex = requiredChangeSetIndex
      briefcase = briefcases.find((entry: BriefcaseEntry): boolean => {
        return entry.briefcaseId === BriefcaseId.Standalone && !entry.isOpen && entry.changeSetIndex === requiredChangeSetIndex;
      });
      if (briefcase)
        return briefcase;

      // next prefer any standalone briefcase that's closed, and with changeSetIndex < requiredChangeSetIndex
      briefcase = briefcases.find((entry: BriefcaseEntry): boolean => {
        return entry.briefcaseId === BriefcaseId.Standalone && !entry.isOpen && entry.changeSetIndex! < requiredChangeSetIndex;
      });
      if (briefcase)
        return briefcase;

      return undefined;
    }

    // For read-write cases...

    // first prefer any briefcase that's been acquired by the user, and with changeSetIndex = requiredChangeSetIndex
    const requiredUserId = accessToken.getUserProfile().userId;
    briefcase = briefcases.find((entry: BriefcaseEntry): boolean => {
      return entry.userId === requiredUserId && entry.changeSetIndex === requiredChangeSetIndex;
    });
    if (briefcase)
      return briefcase;

    // next prefer any briefcase that's been acquired by the user, is currently closed, and with changeSetIndex < requiredChangeSetIndex
    briefcase = briefcases.find((entry: BriefcaseEntry): boolean => {
      return entry.userId === requiredUserId && !entry.isOpen && entry.changeSetIndex! < requiredChangeSetIndex;
    });
    if (briefcase)
      return briefcase;

    return undefined;
  }

  /** Create a briefcase */
  private static async createBriefcase(accessToken: AccessToken, projectId: string, iModelId: string, openMode: OpenMode): Promise<BriefcaseEntry> {
    const iModel: ConnectIModel = await BriefcaseManager.hubClient!.getIModel(accessToken, projectId, {
      $select: "Name",
      $filter: "$id+eq+'" + iModelId + "'",
    });

    const seedFile: SeedFile = await BriefcaseManager.hubClient!.getSeedFile(accessToken, iModelId, true);
    const downloadUrl = seedFile.downloadUrl!;

    const briefcase = new BriefcaseEntry();
    briefcase.changeSetId = seedFile.mergedChangeSetId;
    briefcase.changeSetIndex = await BriefcaseManager.getChangeSetIndexFromId(accessToken, iModelId, briefcase.changeSetId);
    briefcase.iModelId = iModelId;
    briefcase.isOpen = false;
    briefcase.openMode = openMode;
    briefcase.userId = accessToken.getUserProfile().userId;

    let downloadToPathname: string;
    if (openMode === OpenMode.Readonly) {
      downloadToPathname = BriefcaseManager.buildReadOnlyPath(iModelId, iModel.name);
      briefcase.briefcaseId = BriefcaseId.Standalone;
    } else {
      const hubBriefcase: HubBriefcase = await BriefcaseManager.acquireBriefcase(accessToken, iModelId);
      downloadToPathname = BriefcaseManager.buildReadWritePath(iModelId, +hubBriefcase.briefcaseId, iModel.name);
      briefcase.briefcaseId = hubBriefcase.briefcaseId;
      briefcase.fileId = hubBriefcase.fileId;
    }
    briefcase.pathname = downloadToPathname;

    await BriefcaseManager.downloadSeedFile(downloadUrl, downloadToPathname);

    briefcase.openMode = OpenMode.ReadWrite; // Setup briefcase as ReadWrite to allow pull and merge of changes (irrespective of the real openMode)

    const nativeDb: NodeAddonDgnDb = new (NodeAddonRegistry.getAddon()).NodeAddonDgnDb();
    const res: DbResult = nativeDb.setupBriefcase(JSON.stringify(briefcase));
    if (DbResult.BE_SQLITE_OK !== res)
      throw new IModelError(res);

    briefcase.openMode = openMode; // Restore briefcase's openMode
    briefcase.nativeDb = nativeDb;
    briefcase.isOpen = true;

    BriefcaseManager.cache!.addBriefcase(briefcase);
    return briefcase;
  }

  /** Acquire a briefcase */
  private static async acquireBriefcase(accessToken: AccessToken, iModelId: string): Promise<HubBriefcase> {
    const briefcaseId: number = await BriefcaseManager.hubClient!.acquireBriefcase(accessToken, iModelId);
    if (!briefcaseId)
      return Promise.reject(new IModelError(BriefcaseStatus.CannotAcquire));

    const briefcase: HubBriefcase = await BriefcaseManager.hubClient!.getBriefcase(accessToken, iModelId, briefcaseId, true /*=getDownloadUrl*/);
    if (!briefcase) {
      await BriefcaseManager.hubClient!.deleteBriefcase(accessToken, iModelId, briefcaseId)
        .catch(() => {
          assert(false, "Could not delete acquired briefcase");
          return Promise.reject(new IModelError(BriefcaseStatus.CannotDelete));
        });
    }

    return briefcase;
  }

  /** Downloads the briefcase seed file */
  private static async downloadSeedFile(seedUrl: string, seedPathname: string): Promise<void> {
    if (fs.existsSync(seedPathname))
      return;

    BriefcaseManager.makeDirectoryRecursive(path.dirname(seedPathname)); // todo: move this to IModel Hub Client
    await BriefcaseManager.hubClient!.downloadFile(seedUrl, seedPathname)
      .catch(() => {
        assert(false, "Could not download seed file");
        if (fs.existsSync(seedPathname))
          fs.unlinkSync(seedPathname); // Just in case there was a partial download, delete the file
        return Promise.reject(new IModelError(BriefcaseStatus.CannotDownload));
      });
  }

  /** Create a directory, recursively setting up the path as necessary */
  private static makeDirectoryRecursive(dirPath: string) {
    if (fs.existsSync(dirPath))
      return;
    BriefcaseManager.makeDirectoryRecursive(path.dirname(dirPath));
    fs.mkdirSync(dirPath);
  }

  /** Deletes a briefcase from the local disk (if it exists) */
  private static deleteBriefcaseFromLocalDisk(briefcase: BriefcaseEntry) {
    const dirName = path.dirname(briefcase.pathname);
    BriefcaseManager.deleteFolderRecursive(dirName);
  }

  /** Deletes a briefcase from the hub (if it exists) */
  private static async deleteBriefcaseFromHub(accessToken: AccessToken, briefcase: BriefcaseEntry): Promise<void> {
    assert(!!briefcase.iModelId);

    try {
      await BriefcaseManager.hubClient!.getBriefcase(accessToken, briefcase.iModelId, briefcase.briefcaseId, false /*=getDownloadUrl*/);
    } catch (err) {
      return; // Briefcase does not exist on the hub, or cannot be accessed
    }

    await BriefcaseManager.hubClient!.deleteBriefcase(accessToken, briefcase.iModelId, briefcase.briefcaseId)
      .catch(() => {
        Logger.logError("Could not delete the acquired briefcase"); // Could well be that the current user does not have the appropriate access
      });
  }

  /** Deletes a briefcase from the cache (if it exists) */
  private static deleteBriefcaseFromCache(briefcase: BriefcaseEntry) {
    if (!BriefcaseManager.cache!.findBriefcase(briefcase))
      return;

    BriefcaseManager.cache!.deleteBriefcase(briefcase);
  }

  /** Deletes a briefcase, and releases it's references in the iModelHub */
  private static async deleteBriefcase(accessToken: AccessToken, briefcase: BriefcaseEntry): Promise<void> {
    BriefcaseManager.deleteBriefcaseFromCache(briefcase);
    BriefcaseManager.deleteBriefcaseFromLocalDisk(briefcase);
    await BriefcaseManager.deleteBriefcaseFromHub(accessToken, briefcase);
  }

  /** Get change sets */
  private static async getChangeSets(accessToken: AccessToken, iModelId: string, includeDownloadLink?: boolean, toChangeSetId?: string, fromChangeSetId?: string): Promise<ChangeSet[]> {
    if (toChangeSetId === "" /* first version */ || fromChangeSetId === toChangeSetId)
      return new Array<ChangeSet>();

    const allChangeSets: ChangeSet[] = await BriefcaseManager.hubClient!.getChangeSets(accessToken, iModelId, includeDownloadLink, fromChangeSetId);
    if (!toChangeSetId)
      return allChangeSets;

    const changeSets = new Array<ChangeSet>();
    for (const changeSet of allChangeSets) {
      changeSets.push(changeSet);
      if (changeSet.wsgId === toChangeSetId)
        return changeSets;
    }

    return Promise.reject(new IModelError(BriefcaseStatus.VersionNotFound));
  }

  /** Downloads Change Sets in the specified range */
  public static async downloadChangeSets(accessToken: AccessToken, iModelId: string, toChangeSetId?: string, fromChangeSetId?: string): Promise<ChangeSet[]> {
    const changeSets = await BriefcaseManager.getChangeSets(accessToken, iModelId, true /*includeDownloadLink*/, toChangeSetId, fromChangeSetId);
    if (changeSets.length === 0)
      return new Array<ChangeSet>();

    const changeSetsToDownload = new Array<ChangeSet>();
    const changeSetsPath: string = BriefcaseManager.getChangeSetsPath(iModelId);
    for (const changeSet of changeSets) {
      const changeSetPathname = path.join(changeSetsPath, changeSet.fileName);
      if (!fs.existsSync(changeSetPathname))
        changeSetsToDownload.push(changeSet);
    }

    // download
    if (changeSetsToDownload.length > 0) {
      BriefcaseManager.makeDirectoryRecursive(changeSetsPath); // todo: move this to IModel Hub Client
      await BriefcaseManager.hubClient!.downloadChangeSets(changeSetsToDownload, changeSetsPath)
        .catch(() => {
          assert(false, "Could not download ChangeSets");
          BriefcaseManager.deleteFolderRecursive(changeSetsPath); // Just in case there was a partial download, delete the entire folder
          Promise.reject(new IModelError(BriefcaseStatus.CannotDownload));
        });
    }

    return changeSets;
  }

  /** Open a standalone iModel from the local disk */
  public static openStandalone(pathname: string, openMode: OpenMode, enableTransactions: boolean): BriefcaseEntry {
    BriefcaseManager.initialize();

    const nativeDb: NodeAddonDgnDb = new (NodeAddonRegistry.getAddon()).NodeAddonDgnDb();
    const res: DbResult = nativeDb.openDgnDb(pathname, openMode);
    if (DbResult.BE_SQLITE_OK !== res)
      throw new IModelError(res);

    let briefcaseId: number = nativeDb.getBriefcaseId();
    if (enableTransactions) {
      if (briefcaseId === BriefcaseId.Illegal || briefcaseId === BriefcaseId.Master) {
        briefcaseId = BriefcaseId.Standalone;
        nativeDb.setBriefcaseId(briefcaseId);
      }
      assert(nativeDb.getBriefcaseId() !== BriefcaseId.Illegal || nativeDb.getBriefcaseId() !== BriefcaseId.Master);
    }

    const briefcase = new BriefcaseEntry();
    briefcase.briefcaseId = briefcaseId;
    briefcase.changeSetId = nativeDb.getParentChangeSetId();
    briefcase.iModelId = nativeDb.getDbGuid();
    briefcase.isOpen = true;
    briefcase.openMode = openMode;
    briefcase.pathname = pathname;
    briefcase.nativeDb = nativeDb;

    const existingBriefcase = this.findBriefcaseByToken({ iModelId: briefcase.iModelId, changeSetId: briefcase.changeSetId, userId: briefcase.userId, openMode: briefcase.openMode });
    if (existingBriefcase) {
      throw new IModelError(DbResult.BE_SQLITE_CANTOPEN,
        `Cannot open ${briefcase.pathname} since it shares it's DbGuid with ${existingBriefcase.pathname} that was opened earlier`);
    }

    BriefcaseManager.cache!.addBriefcase(briefcase);
    return briefcase;
}

  /** Close the standalone briefcase */
  public static closeStandalone(briefcase: BriefcaseEntry) {
    briefcase.onClose.raiseEvent(briefcase);
    briefcase.nativeDb!.closeDgnDb();
    briefcase.isOpen = false;
    BriefcaseManager.deleteBriefcaseFromCache(briefcase);
  }

  public static attachChangeCache(briefcase: BriefcaseEntry) {
    if (!briefcase.isOpen)
      throw new IModelError(DbResult.BE_SQLITE_ERROR, `Failed to attach change cache to ${briefcase.pathname} because the briefcase is not open.`);

    const csumFilePath: string = BriefcaseManager.buildChangeSummaryFilePath(briefcase.iModelId);
    assert(briefcase.nativeDb != null);
    if (briefcase.nativeDb!.isChangeCacheAttached())
      return;

    const res: DbResult = briefcase.nativeDb!.attachChangeCache(csumFilePath);
    if (res !== DbResult.BE_SQLITE_OK)
      throw new IModelError(res, `Failed to attach change cache to ${briefcase.pathname}.`);
  }

  /** Purge closed briefcases */
  public static async purgeClosed(accessToken: AccessToken) {
    if (!BriefcaseManager.cache)
      await BriefcaseManager.initialize(accessToken);

    const cache = BriefcaseManager.cache!;
    const briefcases = cache.getFilteredBriefcases((briefcase: BriefcaseEntry) => !briefcase.isOpen);
    for (const briefcase of briefcases) {
      await BriefcaseManager.deleteBriefcase(accessToken, briefcase);
    }
  }

  private static deleteFolderRecursive(folderPath: string) {
    if (!fs.existsSync(folderPath))
      return;
    try {
      fs.readdirSync(folderPath).forEach((file) => {
        const curPath = folderPath + "/" + file;
        if (fs.lstatSync(curPath).isDirectory()) {
          BriefcaseManager.deleteFolderRecursive(curPath);
        } else {
          // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(folderPath);
    } catch (err) {
      return; // todo: This seems to fail sometimes for no reason
    }
  }

  /** Purge all briefcases and reset the briefcase manager */
  public static purgeAll() {
    if (fs.existsSync(BriefcaseManager.cachePath))
      BriefcaseManager.deleteFolderRecursive(BriefcaseManager.cachePath);

    BriefcaseManager.cache = undefined;
  }

  /** Find the existing briefcase */
  public static findBriefcaseByToken(iModelToken: IModelToken): BriefcaseEntry | undefined {
    if (!BriefcaseManager.cache)
      return undefined;
    return BriefcaseManager.cache.findBriefcaseByToken(iModelToken);
  }

  private static buildChangeSetTokens(changeSets: ChangeSet[], changeSetsPath: string): ChangeSetToken[] {
    const changeSetTokens = new Array<ChangeSetToken>();
    changeSets.forEach((changeSet: ChangeSet) => {
      const changeSetPathname = path.join(changeSetsPath, changeSet.fileName);
      changeSetTokens.push(new ChangeSetToken(changeSet.wsgId, changeSet.parentId, +changeSet.index, changeSetPathname, changeSet.containsSchemaChanges));
    });
    return changeSetTokens;
  }

  private static openBriefcase(briefcase: BriefcaseEntry) {
    if (!briefcase.nativeDb)
      briefcase.nativeDb = new (NodeAddonRegistry.getAddon()).NodeAddonDgnDb();

    // Note: Open briefcase as ReadWrite, even if briefcase.openMode is Readonly. This is to allow to pull and merge change sets.
    const res: DbResult = briefcase.nativeDb.openDgnDb(briefcase.pathname, OpenMode.ReadWrite);
    if (DbResult.BE_SQLITE_OK !== res)
      throw new IModelError(res);

    briefcase.isOpen = true;
  }

  private static updateVersion(briefcase: BriefcaseEntry, changeSet: ChangeSet) {
    briefcase.changeSetId = changeSet.wsgId;
    briefcase.changeSetIndex = +changeSet.index;
  }

  /**
   * Pull and merge changes from the hub
   * @param accessToken Delegation token of the authorized user
   * @param briefcase Local briefcase
   * @param version Version of the iModel to merge until.
   */
  public static async pullAndMergeChanges(accessToken: AccessToken, briefcase: BriefcaseEntry, version: IModelVersion = IModelVersion.latest()): Promise<void> {
    assert(!!briefcase.nativeDb && briefcase.isOpen);

    const toChangeSetId: string = await version.evaluateChangeSet(accessToken, briefcase.iModelId);

    const changeSets: ChangeSet[] = await BriefcaseManager.downloadChangeSets(accessToken, briefcase.iModelId, toChangeSetId, briefcase.changeSetId);
    if (changeSets.length === 0) {
      return Promise.resolve();
    }
    const changeSetTokens: ChangeSetToken[] = BriefcaseManager.buildChangeSetTokens(changeSets, BriefcaseManager.getChangeSetsPath(briefcase.iModelId));

    // Close Db before merge (if there are schema changes)
    const containsSchemaChanges: boolean = changeSets.some((changeSet: ChangeSet) => changeSet.containsSchemaChanges === ContainsSchemaChanges.Yes);
    if (containsSchemaChanges && briefcase.isOpen)
      BriefcaseManager.close(accessToken, briefcase, KeepBriefcase.Yes);

    const result: DbResult = briefcase.nativeDb!.processChangeSets(JSON.stringify(changeSetTokens), ChangeSetProcessOption.Merge);
    if (DbResult.BE_SQLITE_OK !== result)
      return Promise.reject(new IModelError(result));

    // Reopen Db after merge (if there are schema changes)
    if (containsSchemaChanges)
      BriefcaseManager.openBriefcase(briefcase);

    BriefcaseManager.updateVersion(briefcase, changeSets[changeSets.length - 1]);
  }

  private static startCreateChangeSet(briefcase: BriefcaseEntry): ChangeSetToken {
    const res: ErrorStatusOrResult<DbResult, string> = briefcase.nativeDb!.startCreateChangeSet();
    if (res.error)
      throw new IModelError(res.error.status);
    return JSON.parse(res.result!);
  }

  private static finishCreateChangeSet(briefcase: BriefcaseEntry) {
    const result = briefcase.nativeDb!.finishCreateChangeSet();
    if (DbResult.BE_SQLITE_OK !== result)
      throw new IModelError(result);
  }

  /** Push local changes to the hub */
  public static async pushChanges(accessToken: AccessToken, briefcase: BriefcaseEntry): Promise<void> {

    await BriefcaseManager.pullAndMergeChanges(accessToken, briefcase, IModelVersion.latest());

    const changeSetToken: ChangeSetToken = BriefcaseManager.startCreateChangeSet(briefcase);

    const changeSet = new ChangeSet();
    changeSet.briefcaseId = briefcase.briefcaseId;
    changeSet.id = changeSetToken.id;
    changeSet.parentId = changeSetToken.parentId;
    changeSet.containsSchemaChanges = changeSetToken.containsSchemaChanges;
    changeSet.seedFileId = briefcase.fileId!;
    changeSet.fileSize = fs.statSync(changeSetToken.pathname).size.toString();

    await BriefcaseManager.hubClient!.uploadChangeSet(accessToken, briefcase.iModelId, changeSet, changeSetToken.pathname);

    BriefcaseManager.finishCreateChangeSet(briefcase);
    BriefcaseManager.updateVersion(briefcase, changeSet);
  }

  /** Pushes a new iModel to the Hub */
  public static async uploadIModel(accessToken: AccessToken, projectId: string, pathname: string, hubName?: string, hubDescription?: string, timeOutInMilliseconds: number = 2 * 60 * 1000): Promise<string> {
    await BriefcaseManager.initialize();

    hubName = hubName || path.basename(pathname, ".bim");

    const iModels: ConnectIModel[] = await BriefcaseManager.hubClient!.getIModels(accessToken, projectId, {
      $select: "*",
      $filter: "Name+eq+'" + hubName + "'",
    });
    for (const iModelTemp of iModels) {
      await BriefcaseManager.hubClient!.deleteIModel(accessToken, projectId, iModelTemp.wsgId);
    }

    const iModel: ConnectIModel = await BriefcaseManager.hubClient!.createIModel(accessToken, projectId, hubName, hubDescription);

    const seedFile: SeedFile = await BriefcaseManager.hubClient!.uploadSeedFile(accessToken, iModel.wsgId, pathname, hubDescription)
      .catch(async () => {
        await BriefcaseManager.hubClient!.deleteIModel(accessToken, projectId, iModel.wsgId);
        return Promise.reject(new IModelError(BriefcaseStatus.CannotUpload));
      });

    return new Promise<string>((resolve, reject) => {
      let numRetries: number = 10;
      const retryDelay = timeOutInMilliseconds / numRetries;

      const attempt = () => {
        numRetries--;
        if (numRetries === 0) {
          reject(new IModelError(BriefcaseStatus.CannotUpload));
          return;
        }

        BriefcaseManager.hubClient!.confirmUploadSeedFile(accessToken, iModel.wsgId, seedFile)
          .then((confirmUploadSeedFile: SeedFile) => {
            const initState = confirmUploadSeedFile.initializationState;
            if (initState === SeedFileInitState.Successful) {
              resolve(iModel.wsgId);
              return;
            }

            if (initState !== SeedFileInitState.NotStarted && initState !== SeedFileInitState.Scheduled) {
              reject(new IModelError(BriefcaseStatus.CannotUpload));
              return;
            }
            setTimeout(() => attempt(), retryDelay);
          })
          .catch(() => {
            reject(new IModelError(BriefcaseStatus.CannotUpload));
            return;
          });
      };

      attempt();
    });
  }

}

/** Types that are relative to BriefcaseManager. Typescript declaration merging will make these types appear to be properties of the BriefcaseManager class. */
export namespace BriefcaseManager {

  /** This is a stand-in for NodeAddonBriefcaseManagerResourcesRequest. We cannot (re-)export that for technical reasons. */
  export class ResourcesRequest {
    private constructor() { }

    /** Create an empty ResourcesRequest */
    public static create(): ResourcesRequest {
      return new (NodeAddonRegistry.getAddon()).NodeAddonBriefcaseManagerResourcesRequest();
    }

    /** Convert the request to any */
    public static toAny(req: ResourcesRequest): any {
      return JSON.parse((req as NodeAddonBriefcaseManagerResourcesRequest).toJSON());
    }

  }

  /** How to handle a conflict */
  export const enum ConflictResolution {
    /** Reject the incoming change */
    Reject = 0,
    /** Accept the incoming change */
    Take = 1,
  }

  /** The options for how conflicts are to be handled during change-merging in an OptimisticConcurrencyControlPolicy.
   * The scenario is that the caller has made some changes to the *local* briefcase. Now, the caller is attempting to
   * merge in changes from iModelHub. The properties of this policy specify how to handle the *incoming* changes from iModelHub.
   */
  export interface ConflictResolutionPolicy {
    /** What to do with the incoming change in the case where the same entity was updated locally and also would be updated by the incoming change. */
    updateVsUpdate: ConflictResolution;
    /** What to do with the incoming change in the case where an entity was updated locally and would be deleted by the incoming change. */
    updateVsDelete: ConflictResolution;
    /** What to do with the incoming change in the case where an entity was deleted locally and would be updated by the incoming change. */
    deleteVsUpdate: ConflictResolution;
  }

  /** Specifies an optimistic concurrency policy.
   * Optimistic concurrency allows entities to be modified in the local briefcase without first acquiring locks. Allows codes to be used in the local briefcase without first acquiring them.
   * This creates the possibility that other apps may have uploaded changesets to iModelHub that overlap with local changes.
   * In that case, overlapping changes are merged when changesets are downloaded from iModelHub.
   * A ConflictResolutionPolicy is then applied in cases where an overlapping change conflict with a local change.
   */
  export class OptimisticConcurrencyControlPolicy {
    public conflictResolution: ConflictResolutionPolicy;
    constructor(p: ConflictResolutionPolicy) { this.conflictResolution = p; }
  }

  /** The options for when to acquire locks and codes in the course of a local transaction in a PessimisticConcurrencyControlPolicy */
  export const enum PessimisticLockingPolicy {
    /** Requires that the app must acquire locks for entities *before* modifying them in the local briefcase. Likewise, the app must acquire codes *before* using them in entities that a written to the local briefcase.
     * This policy prevents conflicts or the possibility that local changes would have to be rolled back. Implementing this policy requires the most effort for the app developer, and it requires
     * careful design and implementation to implement it efficiently.
     */
    Immediate = 0,

    /** Allows apps to write entities and codes to the local briefcase without first acquiring locks.
     * The transaction manager then attempts to acquire all needed locks and codes before saving the changes to the local briefcase.
     * The transaction manager will roll back all pending changes if any lock or code cannot be acquired at save time. Lock and code acquisition will fail if another user
     * has push changes to the same entities or used the same codes as the local transaction.
     * This policy does prevent conflicts and is the easiest way to implement the pessimistic locking policy efficiently.
     * It however carries the risk that local changes could be rolled back, and so it can only be used safely in special cases, where
     * contention for locks and codes is not a risk. Normally, that is only possible when writing to a model that is exclusively locked and where codes
     * are scoped to that model.
     */
    Deferred = 1,
  }

  /** Specifies a pessimistic concurrency policy.
   * Pessimistic concurrency means that entities must be locked and codes must be acquired before a local changes can be pushed to iModelHub.
   * There is more than one strategy for when to acquire locks. See briefcaseManagerStartBulkOperation.
   * A pessimistic concurrency policy with respect to iModelHub does not preclude using an optimistic concurrency strategy with respect to members of a workgroup.
   */
  export class PessimisticConcurrencyControlPolicy {
  }
}
