/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { expect } from "chai";
import * as faker from "faker";
import sinon from "sinon";
import * as moq from "typemoq";
import { BeDuration, BeEvent, CompressedId64Set, using } from "@itwin/core-bentley";
import { IModelRpcProps, IpcListener, RemoveFunction } from "@itwin/core-common";
import { IModelConnection, IpcApp } from "@itwin/core-frontend";
import { ITwinLocalization } from "@itwin/core-i18n";
import { UnitSystemKey } from "@itwin/core-quantity";
import {
  Content, ContentDescriptorRequestOptions, ContentInstanceKeysRequestOptions, ContentRequestOptions, ContentSourcesRequestOptions,
  ContentSourcesRpcResult, Descriptor, DescriptorOverrides, DisplayLabelRequestOptions, DisplayLabelsRequestOptions, DisplayValueGroup,
  DistinctValuesRequestOptions, ElementProperties, FieldDescriptor, FieldDescriptorType, FilterByInstancePathsHierarchyRequestOptions,
  FilterByTextHierarchyRequestOptions, HierarchyLevelDescriptorRequestOptions, HierarchyRequestOptions, InstanceKey, Item, KeySet, Node, NodeKey,
  NodePathElement, Paged, PresentationIpcEvents, RegisteredRuleset, RpcRequestsHandler, Ruleset, RulesetVariable, SelectClassInfo,
  SingleElementPropertiesRequestOptions, UpdateInfo, VariableValueTypes,
} from "@itwin/presentation-common";
import {
  createRandomECInstanceKey, createRandomECInstancesNode, createRandomECInstancesNodeKey, createRandomLabelDefinition, createRandomNodePathElement,
  createRandomRuleset, createRandomTransientId, createTestContentDescriptor, createTestECInstanceKey,
} from "@itwin/presentation-common/lib/cjs/test";
import { IpcRequestsHandler } from "../presentation-frontend/IpcRequestsHandler";
import { Presentation } from "../presentation-frontend/Presentation";
import {
  buildPagedArrayResponse, IModelContentChangeEventArgs, IModelHierarchyChangeEventArgs, PresentationManager,
} from "../presentation-frontend/PresentationManager";
import { RulesetManagerImpl } from "../presentation-frontend/RulesetManager";
import { RulesetVariablesManagerImpl } from "../presentation-frontend/RulesetVariablesManager";
import { TRANSIENT_ELEMENT_CLASSNAME } from "../presentation-frontend/selection/SelectionManager";
import { StateTracker } from "../presentation-frontend/StateTracker";

describe("PresentationManager", () => {

  const rulesetsManagerMock = moq.Mock.ofType<RulesetManagerImpl>();
  const rpcRequestsHandlerMock = moq.Mock.ofType<RpcRequestsHandler>();
  let manager: PresentationManager;
  const i18nMock = moq.Mock.ofType<ITwinLocalization>();
  const testData = {
    imodelToken: moq.Mock.ofType<IModelRpcProps>().object,
    imodelMock: moq.Mock.ofType<IModelConnection>(),
    pageOptions: { start: 0, size: 0 },
    rulesetId: "",
  };
  let rulesetManagerCreateStub: sinon.SinonSpy<[], RulesetManagerImpl>;

  beforeEach(() => {
    mockI18N();
    testData.imodelMock.reset();
    testData.imodelMock.setup((x) => x.getRpcProps()).returns(() => testData.imodelToken);
    testData.imodelMock.setup((x) => x.onClose).returns(() => new BeEvent());
    testData.pageOptions = { start: faker.random.number(), size: faker.random.number() };
    testData.rulesetId = faker.random.uuid();
    rulesetsManagerMock.reset();
    rulesetManagerCreateStub = sinon.stub(RulesetManagerImpl, "create").returns(rulesetsManagerMock.object);
    rpcRequestsHandlerMock.reset();
    manager = PresentationManager.create({
      rpcRequestsHandler: rpcRequestsHandlerMock.object,
    });
  });

  afterEach(() => {
    manager.dispose();
    Presentation.terminate();
  });

  const mockI18N = () => {
    i18nMock.reset();
    Presentation.setLocalization(i18nMock.object);
    const resolvedPromise = new Promise<void>((resolve) => resolve());
    i18nMock.setup(async (x) => x.registerNamespace(moq.It.isAny())).returns(async () => resolvedPromise);
    i18nMock.setup((x) => x.getLocalizedString(moq.It.isAny(), moq.It.isAny())).returns((stringId) => stringId);
  };

  const toIModelTokenOptions = <TOptions extends { imodel: IModelConnection, locale?: string, unitSystem?: UnitSystemKey }>(requestOptions: TOptions) => {
    return {
      ...requestOptions,
      imodel: requestOptions.imodel.getRpcProps(),
    };
  };

  const prepareOptions = <TOptions extends { imodel: IModelConnection, rulesetOrId: Ruleset | string, locale?: string, unitSystem?: UnitSystemKey, rulesetVariables?: RulesetVariable[] }>(options: TOptions) => {
    return toIModelTokenOptions({
      ...options,
      rulesetVariables: options.rulesetVariables?.map(RulesetVariable.toJSON) ?? [],
    });
  };

  describe("constructor", () => {

    it("sets active locale if supplied with props", async () => {
      const props = { activeLocale: faker.locale };
      const mgr = PresentationManager.create(props);
      expect(mgr.activeLocale).to.eq(props.activeLocale);
    });

    it("sets active unit system if supplied with props", async () => {
      const props = { activeUnitSystem: "usSurvey" as UnitSystemKey };
      const mgr = PresentationManager.create(props);
      expect(mgr.activeUnitSystem).to.eq(props.activeUnitSystem);
    });

    it("sets custom RpcRequestsHandler if supplied with props", async () => {
      const handler = moq.Mock.ofType<RpcRequestsHandler>();
      const props = { rpcRequestsHandler: handler.object };
      const mgr = PresentationManager.create(props);
      expect(mgr.rpcRequestsHandler).to.eq(handler.object);
    });

    it("sets RpcRequestsHandler clientId if supplied with props", async () => {
      const props = { clientId: faker.random.uuid() };
      const mgr = PresentationManager.create(props);
      expect(mgr.rpcRequestsHandler.clientId).to.eq(props.clientId);
    });

    it("sets RpcRequestsHandler timeout if supplied with props", async () => {
      const props = { requestTimeout: 123 };
      const mgr = PresentationManager.create(props);
      expect(mgr.rpcRequestsHandler.timeout).to.eq(props.requestTimeout);
    });

    it("sets custom IpcRequestsHandler if supplied with props", async () => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      sinon.stub(IpcApp, "addListener");
      const handler = moq.Mock.ofType<IpcRequestsHandler>();
      const props = { ipcRequestsHandler: handler.object };
      const mgr = PresentationManager.create(props);
      expect(mgr.ipcRequestsHandler).to.eq(handler.object);
    });

    it("creates RpcRequestsHandler and IpcRequestsHandler with same client id", async () => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      sinon.stub(IpcApp, "addListener");
      const mgr = PresentationManager.create();
      expect(mgr.rpcRequestsHandler.clientId).to.eq(mgr.ipcRequestsHandler?.clientId);
    });

    it("sets custom StateTracker if supplied with props", async () => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      sinon.stub(IpcApp, "addListener");
      const tracker = moq.Mock.ofType<StateTracker>();
      const mgr = PresentationManager.create({ stateTracker: tracker.object });
      expect(mgr.stateTracker).to.eq(tracker.object);
    });

    it("starts listening to update events", async () => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      const addListenerSpy = sinon.stub(IpcApp, "addListener").returns(() => { });
      using(PresentationManager.create(), (_) => { });
      expect(addListenerSpy).to.be.calledOnceWith(PresentationIpcEvents.Update, sinon.match((arg) => typeof arg === "function"));
    });

  });

  describe("onConnection", () => {

    it("caches IModelConnection and calls `onNewiModelConnection` for the first time", async () => {
      const spy = sinon.stub(manager, "onNewiModelConnection");
      const onCloseEvent = new BeEvent();
      const imodelMock = moq.Mock.ofType<IModelConnection>();
      imodelMock.setup((x) => x.onClose).returns(() => onCloseEvent);
      rpcRequestsHandlerMock.setup(async (x) => x.getNodesCount(moq.It.isAny())).returns(async () => 0);

      // expect the spy to be called on first imodel use
      await manager.getNodesCount({
        imodel: imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      expect(spy).to.be.calledOnceWith(imodelMock.object);
      spy.resetHistory();

      // expect the spy to not be called second time
      await manager.getNodesCount({
        imodel: imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      expect(spy).to.not.be.called;
      spy.resetHistory();

      // simulate imodel close
      onCloseEvent.raiseEvent();

      // expect the spy to be called again
      await manager.getNodesCount({
        imodel: imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      expect(spy).to.be.calledOnceWith(imodelMock.object);
    });

  });

  describe("activeLocale", () => {

    it("requests with manager's locale if not set in request options", async () => {
      const locale = faker.random.locale();
      manager.activeLocale = locale;
      await manager.getNodesCount({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getNodesCount({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        locale,
        rulesetVariables: [],
      }), moq.Times.once());
    });

    it("requests with request's locale if set", async () => {
      const locale = faker.random.locale();
      manager.activeLocale = faker.random.locale();
      expect(manager.activeLocale).to.not.eq(locale);
      await manager.getNodesCount({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        locale,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getNodesCount({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        locale,
        rulesetVariables: [],
      }), moq.Times.once());
    });

  });

  describe("activeUnitSystem", () => {

    it("requests with manager's unit system if not set in request options", async () => {
      const keys = new KeySet();
      const unitSystem = "usSurvey";
      manager.activeUnitSystem = unitSystem;
      await manager.getContentDescriptor({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType: "",
        keys,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getContentDescriptor({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        unitSystem,
        rulesetVariables: [],
        displayType: "",
        keys: keys.toJSON(),
      }), moq.Times.once());
    });

    it("requests with request's locale if set", async () => {
      const keys = new KeySet();
      const unitSystem = "usSurvey";
      manager.activeUnitSystem = "metric";
      await manager.getContentDescriptor({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        unitSystem,
        displayType: "",
        keys,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getContentDescriptor({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        unitSystem,
        rulesetVariables: [],
        displayType: "",
        keys: keys.toJSON(),
      }), moq.Times.once());
    });

  });

  describe("ruleset variables", () => {
    const variableId = faker.random.word();
    const variableValue = faker.random.word();

    beforeEach(async () => {
      await manager.vars(testData.rulesetId).setString(variableId, variableValue);
    });

    it("injects ruleset variables into request options", async () => {
      await manager.getNodesCount({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getNodesCount({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        rulesetVariables: [{ id: variableId, value: variableValue, type: VariableValueTypes.String }],
      }), moq.Times.once());
    });

    it("orders Id64[] ruleset variables before injecting into request options", async () => {
      await manager.getNodesCount({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        rulesetVariables: [{
          type: VariableValueTypes.Id64Array,
          id: "order-id64[]",
          value: ["0x2", "0x1"],
        }],
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getNodesCount({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        rulesetVariables: [
          { id: "order-id64[]", value: CompressedId64Set.compressArray(["0x1", "0x2"]), type: VariableValueTypes.Id64Array },
          { id: variableId, value: variableValue, type: VariableValueTypes.String },
        ],
      }), moq.Times.once());
    });

    it("does not inject ruleset variables into request options in IpcApp", async () => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      sinon.stub(IpcApp, "addListener");
      manager.dispose();
      manager = PresentationManager.create({
        rpcRequestsHandler: rpcRequestsHandlerMock.object,
      });
      await manager.getNodesCount({
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
      });
      rpcRequestsHandlerMock.verify(async (x) => x.getNodesCount({
        imodel: testData.imodelToken,
        rulesetOrId: testData.rulesetId,
        rulesetVariables: [],
      }), moq.Times.once());
    });

  });

  describe("rulesets", () => {

    it("returns rulesets manager provided through props", () => {
      const rulesets = manager.rulesets();
      expect(rulesets).to.eq(rulesetsManagerMock.object);
    });

    it("returns an instance of `RulesetManagerImpl` if not provided through props", () => {
      rulesetManagerCreateStub.restore();
      manager = PresentationManager.create();
      const rulesets = manager.rulesets();
      expect(rulesets).to.be.instanceOf(RulesetManagerImpl);
    });

  });

  describe("vars", () => {

    it("returns ruleset variables manager", () => {
      const vars = manager.vars(testData.rulesetId);
      expect(vars).to.be.instanceOf(RulesetVariablesManagerImpl);

      const vars2 = manager.vars(testData.rulesetId);
      expect(vars2).to.equal(vars);
    });

  });

  describe("getNodesAndCount", () => {

    it("requests root nodes from proxy", async () => {
      const nodes = [createRandomECInstancesNode(), createRandomECInstancesNode()];
      const count = 2;
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        parentKey: undefined,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions(options)))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: nodes.map(Node.toJSON) }))
        .verifiable();
      const actualResult = await manager.getNodesAndCount(options);
      expect(actualResult).to.deep.eq({ count, nodes });
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests child nodes from proxy", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const nodes = [createRandomECInstancesNode(), createRandomECInstancesNode()];
      const count = 2;
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: nodes.map(Node.toJSON) }))
        .verifiable();
      const actualResult = await manager.getNodesAndCount(options);
      expect(actualResult).to.deep.eq({ count, nodes });
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests child nodes through multiple requests when getting partial responses", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const node1 = createRandomECInstancesNode();
      const node2 = createRandomECInstancesNode();
      const count = 2;
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey, paging: { start: 0, size: 0 } })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: [Node.toJSON(node1)] }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey, paging: { start: 1, size: 0 } })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: [Node.toJSON(node2)] }))
        .verifiable();
      const actualResult = await manager.getNodesAndCount(options);
      expect(actualResult).to.deep.eq({ count, nodes: [node1, node2] });
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getNodes", () => {

    it("requests root nodes from proxy", async () => {
      const result = [createRandomECInstancesNode(), createRandomECInstancesNode()];
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        parentKey: undefined,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions(options)))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: 666, items: result.map(Node.toJSON) }))
        .verifiable();
      const actualResult = await manager.getNodes(options);
      expect(actualResult).to.deep.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests localized root nodes from proxy", async () => {
      i18nMock.reset();
      i18nMock.setup((x) => x.getLocalizedString("EN:LocalizableString", moq.It.isAny())).returns(() => "LocalizedString");
      const prelocalizedNode = [createRandomECInstancesNode({ label: { rawValue: "@EN:LocalizableString@", displayValue: "@EN:LocalizableString@", typeName: "string" } })];
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        parentKey: undefined,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions(options)))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: 666, items: prelocalizedNode.map(Node.toJSON) }))
        .verifiable();

      const actualResult = await manager.getNodes(options);
      const expectedResult = prelocalizedNode;
      expectedResult[0].label.rawValue = "LocalizedString";
      expectedResult[0].label.displayValue = "LocalizedString";
      expect(actualResult).to.deep.eq(expectedResult);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests child nodes from proxy", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const result = [createRandomECInstancesNode(), createRandomECInstancesNode()];
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: 666, items: result.map(Node.toJSON) }))
        .verifiable();
      const actualResult = await manager.getNodes(options);
      expect(actualResult).to.deep.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests child nodes through multiple requests when getting partial responses", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const node1 = createRandomECInstancesNode();
      const node2 = createRandomECInstancesNode();
      const count = 2;
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey, paging: { start: 0, size: 0 } })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: [Node.toJSON(node1)] }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedNodes(prepareOptions({ ...options, parentKey: parentNodeKey, paging: { start: 1, size: 0 } })))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: count, items: [Node.toJSON(node2)] }))
        .verifiable();
      const actualResult = await manager.getNodes(options);
      expect(actualResult).to.deep.eq([node1, node2]);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getNodesCount", () => {

    it("requests root nodes count from proxy", async () => {
      const result = faker.random.number();
      const options: HierarchyRequestOptions<IModelConnection, NodeKey> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        parentKey: undefined,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(prepareOptions(options)))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getNodesCount(options);
      expect(actualResult).to.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests child nodes count from proxy", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const result = faker.random.number();
      const options: HierarchyRequestOptions<IModelConnection, NodeKey> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(prepareOptions({ ...options, parentKey: parentNodeKey })))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getNodesCount(options);
      expect(actualResult).to.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getNodesDescriptor", () => {

    it("requests child nodes descriptor from proxy", async () => {
      const parentNodeKey = createRandomECInstancesNodeKey();
      const result = createTestContentDescriptor({ fields: [] });
      const options: HierarchyLevelDescriptorRequestOptions<IModelConnection, NodeKey> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        parentKey: parentNodeKey,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesDescriptor(prepareOptions({ ...options, parentKey: parentNodeKey })))
        .returns(async () => result.toJSON())
        .verifiable();
      const actualResult = await manager.getNodesDescriptor(options);
      expect(actualResult!.toJSON()).to.deep.eq(result.toJSON());
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getFilteredNodePaths", () => {

    it("calls getFilteredNodePaths through proxy", async () => {
      const value = [createRandomNodePathElement(0), createRandomNodePathElement(0)];
      const options: FilterByTextHierarchyRequestOptions<IModelConnection> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        filterText: "test",
      };
      rpcRequestsHandlerMock.setup(async (x) => x.getFilteredNodePaths(prepareOptions(options)))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => value.map(NodePathElement.toJSON))
        .verifiable();
      const result = await manager.getFilteredNodePaths(options);
      expect(result).to.be.deep.equal(value);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getNodePaths", () => {

    it("calls getNodePaths through proxy", async () => {
      const value = [createRandomNodePathElement(0), createRandomNodePathElement(0)];
      const keyArray = [[createRandomECInstanceKey(), createRandomECInstanceKey()]];
      const options: FilterByInstancePathsHierarchyRequestOptions<IModelConnection> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        instancePaths: keyArray,
        markedIndex: 1,
      };
      rpcRequestsHandlerMock.setup(async (x) => x.getNodePaths(prepareOptions(options)))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => value.map(NodePathElement.toJSON))
        .verifiable();
      const result = await manager.getNodePaths(options);
      expect(result).to.be.deep.equal(value);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getContentSources", () => {

    it("requests content sources from proxy", async () => {
      const classes = ["test.class1"];
      const options: ContentSourcesRequestOptions<IModelConnection> = {
        imodel: testData.imodelMock.object,
        classes,
      };
      const rpcRequestsHandlerResponse: ContentSourcesRpcResult = {
        sources: [{
          selectClassInfo: "0x123",
          isSelectPolymorphic: true,
        }],
        classesMap: {
          "0x123": { name: "class_name", label: "Class Label" },
        },
      };
      const expectedResult: SelectClassInfo[] = [{
        selectClassInfo: { id: "0x123", name: "class_name", label: "Class Label" },
        isSelectPolymorphic: true,
      }];
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentSources(toIModelTokenOptions(options)))
        .returns(async () => rpcRequestsHandlerResponse)
        .verifiable();
      const actualResult = await manager.getContentSources(options);
      expect(actualResult).to.deep.eq(expectedResult);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getContentDescriptor", () => {

    it("requests descriptor from proxy", async () => {
      const keyset = new KeySet();
      const result = createTestContentDescriptor({ fields: [] });
      const options: ContentDescriptorRequestOptions<IModelConnection, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType: "test",
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentDescriptor(prepareOptions({ ...options, keys: keyset.toJSON() })))
        .returns(async () => result.toJSON())
        .verifiable();
      const actualResult = await manager.getContentDescriptor(options);
      expect(actualResult).to.be.instanceOf(Descriptor);
      expect(actualResult!.toJSON()).to.deep.eq(result.toJSON());
      rpcRequestsHandlerMock.verifyAll();
    });

    it("skips transient element keys", async () => {
      const persistentKey = createRandomECInstanceKey();
      const transientKey = { className: TRANSIENT_ELEMENT_CLASSNAME, id: createRandomTransientId() };
      const keyset = new KeySet([persistentKey, transientKey]);
      const options: ContentDescriptorRequestOptions<IModelConnection, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType: "test",
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentDescriptor(prepareOptions({ ...options, keys: new KeySet([persistentKey]).toJSON() })))
        .returns(async () => createTestContentDescriptor({ fields: [] }).toJSON())
        .verifiable();
      await manager.getContentDescriptor(options);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("handles undefined descriptor", async () => {
      const keyset = new KeySet();
      const options: ContentDescriptorRequestOptions<IModelConnection, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType: "test",
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentDescriptor(prepareOptions({ ...options, keys: keyset.toJSON() })))
        .returns(async () => undefined)
        .verifiable();
      const actualResult = await manager.getContentDescriptor(options);
      rpcRequestsHandlerMock.verifyAll();
      expect(actualResult).to.be.undefined;
    });

  });

  describe("getContentSetSize", () => {

    it("requests content set size from proxy", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const result = faker.random.number();
      const options: ContentRequestOptions<IModelConnection, Descriptor, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        descriptor,
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentSetSize(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getContentSetSize(options);
      expect(actualResult).to.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests content set size from proxy when descriptor overrides are passed instead of descriptor", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const overrides = descriptor.createDescriptorOverrides();
      const result = faker.random.number();
      const options: ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        descriptor: overrides,
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentSetSize(prepareOptions({ ...options, descriptor: overrides, keys: keyset.toJSON() })))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getContentSetSize(options);
      expect(actualResult).to.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getContent", () => {

    it("requests content from proxy", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const result = {
        total: 999,
        items: [new Item([], "", "", undefined, {}, {}, [])],
      };
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor,
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContentSet(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => ({ ...result, items: result.items.map((i) => i.toJSON()) }))
        .verifiable();
      const actualResult = await manager.getContent(options);
      expect(actualResult).to.be.instanceOf(Content);
      expect(actualResult!.descriptor).to.eq(descriptor);
      expect(actualResult!.contentSet).to.deep.eq(result.items);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests content from proxy when descriptor overrides are passed instead of descriptor", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const overrides = descriptor.createDescriptorOverrides();
      const items = [new Item([], "", "", undefined, {}, {}, [])];
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor: overrides,
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContent(prepareOptions({ ...options, descriptor: overrides, keys: keyset.toJSON() })))
        .returns(async () => ({ descriptor: descriptor.toJSON(), contentSet: { total: 999, items: items.map((i) => i.toJSON()) } }))
        .verifiable();
      const actualResult = await manager.getContent(options);
      expect(actualResult).to.be.instanceOf(Content);
      expect(actualResult!.descriptor).to.deep.eq(descriptor);
      expect(actualResult!.contentSet).to.deep.eq(items);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("handles case when response has no content", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContent(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => undefined)
        .verifiable();
      const actualResult = await manager.getContent(options);
      expect(actualResult).to.be.undefined;
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getContentAndContentSize", () => {

    it("requests content and contentSize from proxy", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const result = {
        total: 999,
        items: [new Item([], "", "", undefined, {}, {}, [])],
      };
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor,
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContentSet(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => ({ ...result, items: result.items.map((i) => i.toJSON()) }))
        .verifiable();
      const actualResult = await manager.getContentAndSize(options);
      expect(actualResult).to.deep.eq({
        size: result.total,
        content: {
          descriptor,
          contentSet: result.items,
        },
      });
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests content and content set size from proxy when descriptor overrides are passed instead of descriptor", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const result = {
        total: 999,
        items: [new Item([], "", "", undefined, {}, {}, [])],
      };
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContent(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => ({ descriptor: descriptor.toJSON(), contentSet: { ...result, items: result.items.map((i) => i.toJSON()) } }))
        .verifiable();
      const actualResult = await manager.getContentAndSize(options);
      expect(actualResult).to.deep.eq({
        size: result.total,
        content: {
          descriptor,
          contentSet: result.items,
        },
      });
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests full content only for the first partial request when using descriptor overrides and multiple partial requests are needed", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const item1 = new Item([], "", "", undefined, {}, {}, []);
      const item2 = new Item([], "", "", undefined, {}, {}, []);
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: { start: 0, size: 2 },
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContent(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON(), paging: { start: 0, size: 2 } })))
        .returns(async () => ({ descriptor: descriptor.toJSON(), contentSet: { total: 5, items: [item1.toJSON()] } }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContentSet(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON(), paging: { start: 1, size: 1 } })))
        .returns(async () => ({ total: 5, items: [item2.toJSON()] }))
        .verifiable();
      const actualResult = await manager.getContentAndSize(options);
      expect(actualResult).to.deep.eq({
        size: 5,
        content: {
          descriptor,
          contentSet: [item1, item2],
        },
      });
      rpcRequestsHandlerMock.verifyAll();
    });

    it("handles case when response has no content", async () => {
      const keyset = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const options: Paged<ContentRequestOptions<IModelConnection, Descriptor | DescriptorOverrides, KeySet>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        paging: testData.pageOptions,
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keyset,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedContent(prepareOptions({ ...options, descriptor: descriptor.createDescriptorOverrides(), keys: keyset.toJSON() })))
        .returns(async () => undefined)
        .verifiable();
      const actualResult = await manager.getContentAndSize(options);
      expect(actualResult).to.be.undefined;
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getPagedDistinctValues", () => {

    it("requests distinct values", async () => {
      const keys = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const fieldDescriptor: FieldDescriptor = {
        type: FieldDescriptorType.Name,
        fieldName: faker.random.word(),
      };
      const result = {
        total: 1,
        items: [{
          displayValue: faker.random.word(),
          groupedRawValues: [faker.random.word(), faker.random.word()],
        }],
      };
      const managerOptions: DistinctValuesRequestOptions<IModelConnection, Descriptor, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        descriptor,
        keys,
        fieldDescriptor,
      };
      const rpcHandlerOptions = {
        ...prepareOptions(managerOptions),
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keys.toJSON(),
        paging: { start: 0, size: 0 },
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDistinctValues(rpcHandlerOptions))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getPagedDistinctValues(managerOptions);
      rpcRequestsHandlerMock.verifyAll();
      expect(actualResult).to.deep.eq(result);
    });

    it("requests distinct values through multiple requests when getting partial responses", async () => {
      const keys = new KeySet();
      const descriptor = createTestContentDescriptor({ fields: [] });
      const fieldDescriptor: FieldDescriptor = {
        type: FieldDescriptorType.Name,
        fieldName: faker.random.word(),
      };
      const item1 = {
        displayValue: faker.random.word(),
        groupedRawValues: [faker.random.word(), faker.random.word()],
      };
      const item2 = {
        displayValue: faker.random.word(),
        groupedRawValues: [faker.random.word(), faker.random.word()],
      };
      const managerOptions: DistinctValuesRequestOptions<IModelConnection, Descriptor, KeySet> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        descriptor,
        keys,
        fieldDescriptor,
        paging: undefined,
      };
      const rpcHandlerOptions = {
        ...prepareOptions(managerOptions),
        descriptor: descriptor.createDescriptorOverrides(),
        keys: keys.toJSON(),
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDistinctValues({ ...rpcHandlerOptions, paging: { start: 0, size: 0 } }))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: 2, items: [DisplayValueGroup.toJSON(item1)] }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDistinctValues({ ...rpcHandlerOptions, paging: { start: 1, size: 0 } }))
        // eslint-disable-next-line deprecation/deprecation
        .returns(async () => ({ total: 2, items: [DisplayValueGroup.toJSON(item2)] }))
        .verifiable();
      const actualResult = await manager.getPagedDistinctValues(managerOptions);
      rpcRequestsHandlerMock.verifyAll();
      expect(actualResult).to.deep.eq({ total: 2, items: [item1, item2] });
    });

  });

  describe("getElementProperties", () => {

    it("requests single element properties", async () => {
      const elementId = "0x123";
      const result: ElementProperties = {
        class: "test class",
        id: elementId,
        label: "test label",
        items: {},
      };
      const options: SingleElementPropertiesRequestOptions<IModelConnection> = {
        imodel: testData.imodelMock.object,
        elementId,
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getElementProperties(toIModelTokenOptions(options)))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getElementProperties(options);
      expect(actualResult).to.deep.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getContentInstanceKeys", () => {

    it("requests content instance keys", async () => {
      const inputKeys = new KeySet();
      const displayType = "test display type";
      const instanceKeys = [createTestECInstanceKey({ id: "0x123" })];
      const rpcHandlerResult = {
        total: 1,
        items: new KeySet(instanceKeys).toJSON(),
      };
      const managerOptions: ContentInstanceKeysRequestOptions<IModelConnection, KeySet, RulesetVariable> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType,
        keys: inputKeys,
      };
      const rpcHandlerOptions = {
        ...prepareOptions(managerOptions),
        keys: inputKeys.toJSON(),
        paging: { start: 0, size: 0 },
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentInstanceKeys(rpcHandlerOptions))
        .returns(async () => rpcHandlerResult)
        .verifiable();
      const actualResult = await manager.getContentInstanceKeys(managerOptions);
      rpcRequestsHandlerMock.verifyAll();
      expect(actualResult.total).to.eq(1);
      expect(await generatedValues(actualResult.items())).to.deep.eq(instanceKeys);
    });

    it("requests instance keys through multiple requests when getting partial responses", async () => {
      const inputKeys = new KeySet();
      const displayType = "test display type";
      const instanceKeys1 = [createTestECInstanceKey({ id: "0x1" }), createTestECInstanceKey({ id: "0x2" })];
      const instanceKeys2 = [createTestECInstanceKey({ id: "0x3" }), createTestECInstanceKey({ id: "0x4" })];
      const managerOptions: ContentInstanceKeysRequestOptions<IModelConnection, KeySet, RulesetVariable> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testData.rulesetId,
        displayType,
        keys: inputKeys,
        paging: undefined,
      };
      const rpcHandlerOptions = {
        ...prepareOptions(managerOptions),
        keys: inputKeys.toJSON(),
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentInstanceKeys({ ...rpcHandlerOptions, paging: { start: 0, size: 0 } }))
        .returns(async () => ({ total: 4, items: new KeySet(instanceKeys1).toJSON() }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getContentInstanceKeys({ ...rpcHandlerOptions, paging: { start: 2, size: 0 } }))
        .returns(async () => ({ total: 4, items: new KeySet(instanceKeys2).toJSON() }))
        .verifiable();
      const actualResult = await manager.getContentInstanceKeys(managerOptions);
      expect(actualResult.total).to.eq(4);
      expect(await generatedValues(actualResult.items())).to.deep.eq([...instanceKeys1, ...instanceKeys2]);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getDisplayLabelDefinition", () => {

    it("requests display label definition", async () => {
      const result = createRandomLabelDefinition();
      const options: DisplayLabelRequestOptions<IModelConnection, InstanceKey> = {
        imodel: testData.imodelMock.object,
        key: createRandomECInstanceKey(),
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getDisplayLabelDefinition(toIModelTokenOptions({ ...options })))
        .returns(async () => result)
        .verifiable();
      const actualResult = await manager.getDisplayLabelDefinition(options);
      expect(actualResult).to.deep.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("getDisplayLabelDefinitions", () => {

    it("requests display labels definitions", async () => {
      const result = [createRandomLabelDefinition(), createRandomLabelDefinition()];
      const options: DisplayLabelsRequestOptions<IModelConnection, InstanceKey> = {
        imodel: testData.imodelMock.object,
        keys: [createRandomECInstanceKey(), createRandomECInstanceKey()],
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDisplayLabelDefinitions(toIModelTokenOptions({ ...options })))
        .returns(async () => ({ total: 2, items: result }))
        .verifiable();
      const actualResult = await manager.getDisplayLabelDefinitions(options);
      expect(actualResult).to.deep.eq(result);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("requests display labels definitions through multiple requests when getting partial responses", async () => {
      const key1 = createRandomECInstanceKey();
      const key2 = createRandomECInstanceKey();
      const def1 = createRandomLabelDefinition();
      const def2 = createRandomLabelDefinition();
      const options: DisplayLabelsRequestOptions<IModelConnection, InstanceKey> = {
        imodel: testData.imodelMock.object,
        keys: [key1, key2],
      };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDisplayLabelDefinitions(toIModelTokenOptions({ ...options, keys: [key1, key2] })))
        .returns(async () => ({ total: 2, items: [def1] }))
        .verifiable();
      rpcRequestsHandlerMock
        .setup(async (x) => x.getPagedDisplayLabelDefinitions(toIModelTokenOptions({ ...options, keys: [key2] })))
        .returns(async () => ({ total: 2, items: [def2] }))
        .verifiable();
      const actualResult = await manager.getDisplayLabelDefinitions(options);
      expect(actualResult).to.deep.eq([def1, def2]);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("options handling", () => {

    let testRuleset: Ruleset;
    let testRulesetVariable: RulesetVariable;

    beforeEach(async () => {
      testRuleset = await createRandomRuleset();
      rulesetsManagerMock.setup(async (x) => x.get(testRuleset.id)).returns(async () => new RegisteredRuleset(testRuleset, "", () => { }));
      testRulesetVariable = { id: faker.random.word(), type: VariableValueTypes.String, value: faker.random.word() };
      await manager.vars(testRuleset.id).setString(testRulesetVariable.id, testRulesetVariable.value);
    });

    it("adds ruleset to the options", async () => {
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        paging: testData.pageOptions,
        rulesetOrId: testRuleset.id,
        parentKey: undefined,
      };
      const expectedOptions = { ...options, rulesetOrId: testRuleset, rulesetVariables: [testRulesetVariable] };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(prepareOptions(expectedOptions)))
        .returns(async () => 0)
        .verifiable();
      await manager.getNodesCount(options);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("leaves ruleset in the options if already provided", async () => {
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        rulesetOrId: testRuleset,
        paging: testData.pageOptions,
        parentKey: undefined,
      };

      const expectedOptions = { ...options, rulesetOrId: testRuleset, rulesetVariables: [testRulesetVariable] };

      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(prepareOptions(expectedOptions)))
        .returns(async () => 0)
        .verifiable();
      await manager.getNodesCount(options);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("adds empty values if ruleset and rulesetId is not provided", async () => {
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey>> = {
        imodel: testData.imodelMock.object,
        paging: testData.pageOptions,
        rulesetOrId: "",
        parentKey: undefined,
      };
      const expectedOptions = { ...options, rulesetVariables: [] };
      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(toIModelTokenOptions(expectedOptions)))
        .returns(async () => 0)
        .verifiable();
      await manager.getNodesCount(options);
      rpcRequestsHandlerMock.verifyAll();
    });

    it("appends ruleset variables from ruleset variables manager", async () => {
      const rulesetVariable: RulesetVariable = { id: faker.random.word(), type: VariableValueTypes.String, value: faker.random.word() };
      const options: Paged<HierarchyRequestOptions<IModelConnection, NodeKey, RulesetVariable>> = {
        imodel: testData.imodelMock.object,
        paging: testData.pageOptions,
        rulesetOrId: testRuleset,
        rulesetVariables: [rulesetVariable],
        parentKey: undefined,
      };

      const expectedOptions = { ...options, rulesetOrId: testRuleset, rulesetVariables: [rulesetVariable, testRulesetVariable] };

      rpcRequestsHandlerMock
        .setup(async (x) => x.getNodesCount(prepareOptions(expectedOptions)))
        .returns(async () => 0)
        .verifiable();
      await manager.getNodesCount(options);
      rpcRequestsHandlerMock.verifyAll();
    });

  });

  describe("listening to updates", () => {

    let ipcAppAddListenerStub: sinon.SinonStub<[string, IpcListener], RemoveFunction>;
    let hierarchyUpdatesSpy: sinon.SinonSpy<[IModelHierarchyChangeEventArgs], void>;
    let contentUpdatesSpy: sinon.SinonSpy<[IModelContentChangeEventArgs], void>;

    beforeEach(() => {
      sinon.stub(IpcApp, "isValid").get(() => true);
      ipcAppAddListenerStub = sinon.stub(IpcApp, "addListener");

      manager = PresentationManager.create();

      expect(ipcAppAddListenerStub).to.be.calledOnce;

      hierarchyUpdatesSpy = sinon.spy() as any;
      manager.onIModelHierarchyChanged.addListener(hierarchyUpdatesSpy);

      contentUpdatesSpy = sinon.spy() as any;
      manager.onIModelContentChanged.addListener(contentUpdatesSpy);
    });

    it("triggers appropriate hierarchy and content events on update event", async () => {
      const imodelKey = "test-imodel-key";
      const ruleset1: Ruleset = { id: "1", rules: [] };
      const ruleset2: Ruleset = { id: "2", rules: [] };
      const ruleset3: Ruleset = { id: "3", rules: [] };
      const ruleset4: Ruleset = { id: "4", rules: [] };
      rulesetsManagerMock.setup(async (x) => x.get(ruleset1.id)).returns(async () => new RegisteredRuleset(ruleset1, "", () => { }));
      rulesetsManagerMock.setup(async (x) => x.get(ruleset2.id)).returns(async () => new RegisteredRuleset(ruleset2, "", () => { }));
      rulesetsManagerMock.setup(async (x) => x.get(ruleset3.id)).returns(async () => new RegisteredRuleset(ruleset3, "", () => { }));
      rulesetsManagerMock.setup(async (x) => x.get(ruleset4.id)).returns(async () => undefined);

      const report: UpdateInfo = {
        [imodelKey]: {
          [ruleset1.id]: {
            hierarchy: "FULL",
            content: "FULL",
          },
          [ruleset2.id]: {
            hierarchy: [],
          },
          [ruleset3.id]: {
            content: "FULL",
          },
          [ruleset4.id]: {},
        },
      };
      ipcAppAddListenerStub.firstCall.args[1](new Event(PresentationIpcEvents.Update), report);

      // workaround for a floating promise...
      await BeDuration.wait(1);

      expect(hierarchyUpdatesSpy).to.be.calledTwice;
      expect(hierarchyUpdatesSpy.firstCall).to.be.calledWith({
        rulesetId: ruleset1.id,
        updateInfo: "FULL",
        imodelKey,
      });
      expect(hierarchyUpdatesSpy.secondCall).to.be.calledWith({
        rulesetId: ruleset2.id,
        updateInfo: [],
        imodelKey,
      });

      expect(contentUpdatesSpy).to.be.calledTwice;
      expect(contentUpdatesSpy.firstCall).to.be.calledWith({
        rulesetId: ruleset1.id,
        updateInfo: "FULL",
        imodelKey,
      });
      expect(contentUpdatesSpy.secondCall).to.be.calledWith({
        rulesetId: ruleset3.id,
        updateInfo: "FULL",
        imodelKey,
      });
    });

  });

  describe("buildPagedArrayResponse", () => {

    it("calls getter once with 0,0 partial page options when given `undefined` page options", async () => {
      const getter = sinon.stub().resolves({ total: 0, items: [] });
      await buildPagedArrayResponse(undefined, getter);
      expect(getter).to.be.calledOnceWith({ start: 0, size: 0 });
    });

    it("calls getter once with 0,0 partial page options when given empty page options", async () => {
      const getter = sinon.stub().resolves({ total: 0, items: [] });
      await buildPagedArrayResponse({}, getter);
      expect(getter).to.be.calledOnceWith({ start: 0, size: 0 });
    });

    it("calls getter once with partial page options equal to given page options", async () => {
      const getter = sinon.stub().resolves({ total: 0, items: [] });
      await buildPagedArrayResponse({ start: 1, size: 2 }, getter);
      expect(getter).to.be.calledOnceWith({ start: 1, size: 2 });
    });

    it("calls getter multiple times until the whole requested page is received when requesting a page of specified size", async () => {
      const getter = sinon.stub();
      getter.onFirstCall().resolves({ total: 5, items: [2] });
      getter.onSecondCall().resolves({ total: 5, items: [3] });
      getter.onThirdCall().resolves({ total: 5, items: [4] });
      const result = await buildPagedArrayResponse({ start: 1, size: 3 }, getter);
      expect(getter).to.be.calledThrice;
      expect(getter.firstCall).to.be.calledWith({ start: 1, size: 3 });
      expect(getter.secondCall).to.be.calledWith({ start: 2, size: 2 });
      expect(getter.thirdCall).to.be.calledWith({ start: 3, size: 1 });
      expect(result).to.deep.eq({ total: 5, items: [2, 3, 4] });
    });

    it("calls getter multiple times until the whole requested page is received when requesting a page of unspecified size", async () => {
      const getter = sinon.stub();
      getter.onFirstCall().resolves({ total: 5, items: [2, 3] });
      getter.onSecondCall().resolves({ total: 5, items: [4, 5] });
      const result = await buildPagedArrayResponse({ start: 1 }, getter);
      expect(getter).to.be.calledTwice;
      expect(getter.firstCall).to.be.calledWith({ start: 1, size: 0 });
      expect(getter.secondCall).to.be.calledWith({ start: 3, size: 0 });
      expect(result).to.deep.eq({ total: 5, items: [2, 3, 4, 5] });
    });

    it("returns zero response when page start index is larger than total number of items", async () => {
      const getter = sinon.stub();
      getter.resolves({ total: 5, items: [] });
      const result = await buildPagedArrayResponse({ start: 9 }, getter);
      expect(getter).to.be.calledOnce;
      expect(getter).to.be.calledWith({ start: 9, size: 0 });
      expect(result).to.deep.eq({ total: 0, items: [] });
    });

    it("returns zero response when partial request returns no items", async () => {
      const getter = sinon.stub();
      getter.resolves({ total: 5, items: [] });
      const result = await buildPagedArrayResponse({ start: 1 }, getter);
      expect(getter).to.be.calledOnce;
      expect(getter).to.be.calledWith({ start: 1, size: 0 });
      expect(result).to.deep.eq({ total: 0, items: [] });
    });

    it("returns zero response when partial request returns less items than requested", async () => {
      const getter = sinon.stub();
      getter.onFirstCall().resolves({ total: 5, items: [2, 3] });
      getter.onSecondCall().resolves({ total: 5, items: [] });
      const result = await buildPagedArrayResponse({ start: 1 }, getter);
      expect(getter).to.be.calledTwice;
      expect(getter.firstCall).to.be.calledWith({ start: 1, size: 0 });
      expect(getter.secondCall).to.be.calledWith({ start: 3, size: 0 });
      expect(result).to.deep.eq({ total: 0, items: [] });
    });

  });

});

async function generatedValues<T>(gen: AsyncGenerator<T>) {
  const arr = new Array<T>();
  for await (const v of gen)
    arr.push(v);
  return arr;
}
