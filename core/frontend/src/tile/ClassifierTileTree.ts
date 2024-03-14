/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tiles
 */
import { comparePossiblyUndefined, compareStrings, compareStringsOrUndefined, Id64, Id64String } from "@itwin/core-bentley";
import {
  BatchType, ClassifierTileTreeId, iModelTileTreeIdToString, RenderMode, RenderSchedule, SpatialClassifier, SpatialClassifiers, ViewFlagsProperties, VolumeClassifierModelProps,
} from "@itwin/core-common";
import { Box, Point3d, Range3d } from "@itwin/core-geometry";
import { DisplayStyleState } from "../DisplayStyleState";
import { IModelApp } from "../IModelApp";
import { IModelConnection } from "../IModelConnection";
import { GeometricModelState } from "../ModelState";
import { SceneContext } from "../ViewContext";
import { ViewState } from "../ViewState";
import {
  DisclosedTileTreeSet, IModelTileTree, iModelTileTreeParamsFromJSON, TileTree, TileTreeLoadStatus, TileTreeOwner, TileTreeReference, TileTreeSupplier,
} from "./internal";
import { GraphicType } from "../render/GraphicBuilder";
import { GraphicList } from "../render/RenderGraphic";

interface ClassifierTreeId extends ClassifierTileTreeId {
  modelId: Id64String;
  timeline?: RenderSchedule.ModelTimeline;
}

function compareIds(lhs: ClassifierTreeId, rhs: ClassifierTreeId): number {
  return compareStrings(lhs.modelId, rhs.modelId) || compareStringsOrUndefined(lhs.animationId, rhs.animationId)
    || comparePossiblyUndefined((x, y) => x.compareTo(y), lhs.timeline, rhs.timeline);
}

class ClassifierTreeSupplier implements TileTreeSupplier {
  private readonly _nonexistentTreeOwner = {
    tileTree: undefined,
    loadStatus: TileTreeLoadStatus.NotFound,
    load: () => undefined,
    dispose: () => undefined,
    loadTree: async () => undefined,
    iModel: undefined as unknown as IModelConnection,
  };

  public compareTileTreeIds(lhs: ClassifierTreeId, rhs: ClassifierTreeId): number {
    return compareIds(lhs, rhs);
  }

  public async createTileTree(id: ClassifierTreeId, iModel: IModelConnection): Promise<TileTree | undefined> {
    await iModel.models.load(id.modelId);
    const model = iModel.models.getLoaded(id.modelId);
    if (undefined === model || !(model instanceof GeometricModelState))
      return undefined;

    const idStr = iModelTileTreeIdToString(id.modelId, id, IModelApp.tileAdmin);
    const props = await IModelApp.tileAdmin.requestTileTreeProps(iModel, idStr);

    const params = iModelTileTreeParamsFromJSON(props, iModel, id.modelId, {
      edges: false,
      allowInstancing: false,
      is3d: true,
      batchType: id.type,
      timeline: id.timeline,
    });

    return new IModelTileTree(params, id);
  }

  public getOwner(id: ClassifierTreeId, iModel: IModelConnection): TileTreeOwner {
    return Id64.isValid(id.modelId) ? iModel.tiles.getTileTreeOwner(id, this) : this._nonexistentTreeOwner;
  }

  public addModelsAnimatedByScript(modelIds: Set<Id64String>, scriptSourceId: Id64String, trees: Iterable<{ id: ClassifierTreeId, owner: TileTreeOwner }>): void {
    // Note: This is invoked when an element hosting a schedule script is updated - it doesn't care about frontend schedule scripts.
    for (const tree of trees)
      if (scriptSourceId === tree.id.animationId)
        modelIds.add(tree.id.modelId);
  }

  public addSpatialModels(modelIds: Set<Id64String>, trees: Iterable<{ id: ClassifierTreeId, owner: TileTreeOwner }>): void {
    for (const tree of trees)
      modelIds.add(tree.id.modelId);
  }
}

const classifierTreeSupplier = new ClassifierTreeSupplier();

/** @internal */
export abstract class SpatialClassifierTileTreeReference extends TileTreeReference {
  public abstract get isPlanar(): boolean;
  public abstract get activeClassifier(): SpatialClassifier | undefined;
  public get isOpaque() { return false; }   /** When referenced as a map layer reference, BIM models are never opaque. */
  public abstract get viewFlags(): Partial<ViewFlagsProperties>;
  public get transparency(): number | undefined { return undefined; }
}

/** @internal */
class ClassifierTreeReference extends SpatialClassifierTileTreeReference {
  private _id: ClassifierTreeId;
  private readonly _classifiers: SpatialClassifiers;
  private readonly _source: ViewState | DisplayStyleState;
  private readonly _iModel: IModelConnection;
  private readonly _classifiedTree: TileTreeReference;
  private _owner: TileTreeOwner;
  private _graphicList: GraphicList | undefined = undefined;

  public constructor(classifiers: SpatialClassifiers, classifiedTree: TileTreeReference, iModel: IModelConnection, source: ViewState | DisplayStyleState) {
    super();
    this._id = createClassifierId(classifiers.active, source);
    this._source = source;
    this._iModel = iModel;
    this._classifiers = classifiers;
    this._classifiedTree = classifiedTree;
    this._owner = classifierTreeSupplier.getOwner(this._id, iModel);
  }

  public get classifiers(): SpatialClassifiers { return this._classifiers; }
  public get activeClassifier(): SpatialClassifier | undefined { return this.classifiers.active; }

  public override get castsShadows() {
    return false;
  }

  public get treeOwner(): TileTreeOwner {
    const newId = createClassifierId(this._classifiers.active, this._source);
    if (0 !== compareIds(this._id, newId)) {
      this._id = newId;
      this._owner = classifierTreeSupplier.getOwner(this._id, this._iModel);
      this._graphicList = undefined;
    }

    return this._owner;
  }

  public override discloseTileTrees(trees: DisclosedTileTreeSet): void {
    // NB: We do NOT call super because we don't use our tree if no classifier is active.
    trees.disclose(this._classifiedTree);

    const classifier = this.activeClassifier;
    const classifierTree = undefined !== classifier ? this.treeOwner.tileTree : undefined;
    if (undefined !== classifierTree)
      trees.add(classifierTree);
  }
  public get isPlanar() { return BatchType.PlanarClassifier === this._id.type; }

  public get viewFlags(): Partial<ViewFlagsProperties> {
    return {
      renderMode: RenderMode.SmoothShade,
      transparency: true,      // Igored for point clouds as they don't support transparency.
      textures: false,
      lighting: false,
      shadows: false,
      monochrome: false,
      materials: false,
      ambientOcclusion: false,
      visibleEdges: false,
      hiddenEdges: false,
    };
  }

  private createVolumeClassifierGeometry(context: SceneContext, modelId: VolumeClassifierModelProps[]) {

    this._graphicList = modelId.map((m) => {

      const builder = context.renderSystem.createGraphic({ type: GraphicType.Scene, viewport: context.viewport, pickable: { id: m.id } });
      builder.setSymbology(m.color, m.color, 1);
      const points = m.points.map((p) => {

        let point3d = Point3d.fromJSON(p);
        if (m.transform) {
          point3d = m.transform?.multiplyPoint3d(point3d) ?? Point3d.create();
        }
        return point3d;
      });

      const range = Range3d.createArray(points);

      const box = Box.createRange(range, true);
      const inv = m.transform?.inverse();
      inv && box?.tryTransformInPlace(inv);
      box && builder.addSolidPrimitive(box);
      return builder.finish();
    });

  }

  // Add volume classifiers to scene (planar classifiers are added seperately.)
  public override addToScene(context: SceneContext): void {
    if (this.isPlanar)
      return;

    const classifiedTree = this._classifiedTree.treeOwner.load();
    if (undefined === classifiedTree)
      return;

    const classifier = this._classifiers.active;
    if (undefined === classifier)
      return;

    if (typeof classifier.modelId === "string") {
      const classifierTree = this.treeOwner.load();
      if (undefined === classifierTree)
        return;
    } else if (!this._graphicList) {
      this.createVolumeClassifierGeometry(context, classifier.modelId);
    }

    context.setVolumeClassifier(classifier, classifiedTree.modelId, this._graphicList);

    super.addToScene(context);
  }

}

/** @internal */
export function createClassifierTileTreeReference(classifiers: SpatialClassifiers, classifiedTree: TileTreeReference, iModel: IModelConnection, source: ViewState | DisplayStyleState): SpatialClassifierTileTreeReference {
  return new ClassifierTreeReference(classifiers, classifiedTree, iModel, source);
}

function createClassifierId(classifier: SpatialClassifier | undefined, source: ViewState | DisplayStyleState | undefined): ClassifierTreeId {
  if (undefined === classifier)
    return { modelId: Id64.invalid, type: BatchType.PlanarClassifier, expansion: 0, animationId: undefined };

  const type = classifier.flags.isVolumeClassifier ? BatchType.VolumeClassifier : BatchType.PlanarClassifier;

  let scriptInfo;
  if (typeof classifier.modelId === "string") {
    scriptInfo = IModelApp.tileAdmin.getScriptInfoForTreeId(classifier.modelId, source?.scheduleScriptReference); // eslint-disable-line deprecation/deprecation
  }

  return {
    modelId: typeof classifier.modelId === "string" ? classifier.modelId : classifier.modelId[0].id,
    type,
    expansion: classifier.expand,
    animationId: scriptInfo?.animationId,
    timeline: scriptInfo?.timeline,
  };
}
