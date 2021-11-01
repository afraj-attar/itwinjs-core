/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import * as enzyme from "enzyme";
import { createStore, Store } from "redux";
import * as sinon from "sinon";
import { fireEvent } from "@testing-library/react";
import { expect } from "chai";

import { Localization } from "@itwin/core-common";
import { ITwinLocalization } from "@itwin/core-i18n";
import { UserInfo } from "../appui-react/UserInfo";
import { ContentLayoutProps, PrimitiveValue, PropertyDescription, PropertyEditorInfo, PropertyRecord, PropertyValueFormat, StandardContentLayouts, StandardTypeNames } from "@itwin/appui-abstract";
import { UiSettings, UiSettingsResult, UiSettingsStatus } from "@itwin/core-react";

import {
  ActionsUnion, combineReducers, ContentGroup, createAction, DeepReadonly, FrameworkReducer,
  FrameworkState, SyncUiEventDispatcher, ToolSettingsManager, UiFramework,
} from "../appui-react";
import { TestContentControl } from "./frontstage/FrontstageTestUtils";

interface SampleAppState {
  placeHolder?: boolean;
}

const initialState: SampleAppState = {
  placeHolder: false,
};

/** @internal */
export interface RootState {
  sampleAppState: SampleAppState;
  testDifferentFrameworkKey?: FrameworkState;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const SampleAppActions = {
  // eslint-disable-next-line jsdoc/require-jsdoc
  example: () => createAction("SampleApp:EXAMPLE"),
};

/** @internal */
export type SampleAppActionsUnion = ActionsUnion<typeof SampleAppActions>;

function SampleAppReducer(state: SampleAppState = initialState, action: SampleAppActionsUnion): DeepReadonly<SampleAppState> {
  switch (action.type) {
    case "SampleApp:EXAMPLE": {
      return { ...state, placeHolder: true };
    }
  }

  return state;
}

/** @internal */
export class TestUtils {
  private static _localization?: Localization;
  private static _uiFrameworkInitialized = false;
  public static store: Store<RootState>;

  private static _rootReducer: any;

  public static get localization(): Localization {
    return TestUtils._localization!;
  }

  public static async initializeUiFramework(testAlternateKey = false) {
    if (!TestUtils._uiFrameworkInitialized) {
      TestUtils._localization = new ITwinLocalization();
      await TestUtils._localization.initialize(["IModelJs"]);
      if (testAlternateKey) {
        // this is the rootReducer for the test application.
        this._rootReducer = combineReducers({
          sampleAppState: SampleAppReducer,
          testDifferentFrameworkKey: FrameworkReducer,
        });

      } else {
        // this is the rootReducer for the test application.
        this._rootReducer = combineReducers({
          sampleAppState: SampleAppReducer,
          frameworkState: FrameworkReducer,
        });
      }

      this.store = createStore(this._rootReducer,
        (window as any).__REDUX_DEVTOOLS_EXTENSION__ && (window as any).__REDUX_DEVTOOLS_EXTENSION__());

      if (testAlternateKey)
        await UiFramework.initialize(this.store, "testDifferentFrameworkKey");
      else
        await UiFramework.initialize(this.store);

      TestUtils._uiFrameworkInitialized = true;
    }
    ToolSettingsManager.clearToolSettingsData();
    SyncUiEventDispatcher.setTimeoutPeriod(0); // disables non-immediate event processing.
  }

  public static terminateUiFramework() {
    UiFramework.terminate();
    TestUtils._uiFrameworkInitialized = false;
  }

  /** Define Content Layouts referenced by Frontstages.
   */

  public static fourQuadrants: ContentLayoutProps = {
    id: "FourQuadrants",
    description: "SampleApp:ContentLayoutDef.FourQuadrants",
    horizontalSplit: {
      id: "FourQuadrants.MainHorizontal",
      percentage: 0.50,
      top: { verticalSplit: { id: "FourQuadrants.TopVert", percentage: 0.50, left: 0, right: 1 } },
      bottom: { verticalSplit: { id: "FourQuadrants.BottomVert", percentage: 0.50, left: 2, right: 3 } },
    },
  };

  /** Define Content Groups referenced by Frontstages.
   */
  public static TestContentGroup1 = new ContentGroup({
    id: "TestContentGroup1",
    layout: StandardContentLayouts.fourQuadrants,
    contents: [
      {
        id: "test:TestContentControl1",
        classId: TestContentControl,
        applicationData: { label: "Content 1a", bgColor: "black" },
      },
      {
        id: "test:TestContentControl2",
        classId: TestContentControl,
        applicationData: { label: "Content 2a", bgColor: "black" },
      },
      {
        id: "test:TestContentControl3",
        classId: TestContentControl,
        applicationData: { label: "Content 3a", bgColor: "black" },
      },
      {
        id: "test:TestContentControl4",
        classId: TestContentControl,
        applicationData: { label: "Content 4a", bgColor: "black" },
      },
    ],
  });

  public static TestContentGroup2 = new ContentGroup({
    id: "TestContentGroup2",
    layout: StandardContentLayouts.singleView,
    contents: [
      {
        id: "test:TestContentControl2",
        classId: TestContentControl,
        applicationData: { label: "Content 1a", bgColor: "black" },
      },
    ],
  });

  /** Waits until all async operations finish */
  public static async flushAsyncOperations() {
    return new Promise((resolve) => setTimeout(resolve));
  }

  public static createBubbledEvent(type: string, props = {}) {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, props);
    return event;
  }

  public static createPrimitiveStringProperty(name: string, rawValue: string, displayValue: string = rawValue.toString(), editorInfo?: PropertyEditorInfo) {
    const value: PrimitiveValue = {
      displayValue,
      value: rawValue,
      valueFormat: PropertyValueFormat.Primitive,
    };

    const description: PropertyDescription = {
      displayLabel: name,
      name,
      typename: StandardTypeNames.String,
    };

    if (editorInfo)
      description.editor = editorInfo;

    const property = new PropertyRecord(value, description);
    property.isReadonly = false;
    return property;
  }

}

// cSpell:ignore testuser mailinator saml

/** @internal */
export const mockUserInfo = (): UserInfo => {
  const id = "596c0d8b-eac2-46a0-aa4a-b590c3314e7c";
  const email = { id: "testuser001@mailinator.com" };
  const profile = { firstName: "test", lastName: "user" };
  const organization = { id: "fefac5b-bcad-488b-aed2-df27bffe5786", name: "Bentley" };
  const featureTracking = { ultimateSite: "1004144426", usageCountryIso: "US" };
  return new UserInfo(id, email, profile, organization, featureTracking);
};

/** @internal */
export const storageMock = () => {
  const storage: { [key: string]: any } = {};
  return {
    setItem: (key: string, value: string) => {
      storage[key] = value || "";
    },
    getItem: (key: string) => {
      return key in storage ? storage[key] : null;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    get length() {
      return Object.keys(storage).length;
    },
    key: (i: number) => {
      const keys = Object.keys(storage);
      return keys[i] || null;
    },
  };
};

/** @internal */
export class UiSettingsStub implements UiSettings {
  public async deleteSetting(): Promise<UiSettingsResult> {
    return {
      status: UiSettingsStatus.Success,
      setting: {},
    };
  }

  public async getSetting(): Promise<UiSettingsResult> {
    return {
      status: UiSettingsStatus.NotFound,
      setting: {},
    };
  }

  public async saveSetting(): Promise<UiSettingsResult> {
    return {
      status: UiSettingsStatus.Success,
      setting: {},
    };
  }
}

/** Stubs requestAnimationFrame. */
export function stubRaf() {
  const raf = window.requestAnimationFrame;
  const caf = window.cancelAnimationFrame;

  before(() => {
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      return window.setTimeout(cb, 0);
    };
    window.cancelAnimationFrame = (handle: number) => {
      window.clearTimeout(handle);
    };
  });

  after(() => {
    window.requestAnimationFrame = raf;
    window.cancelAnimationFrame = caf;
  });
}

/** @internal */
export type ReactWrapper<C extends React.Component, P = C["props"], S = C["state"]> = enzyme.ReactWrapper<P, S, C>;

declare module "sinon" {
  interface SinonStubStatic {
    // eslint-disable-next-line @typescript-eslint/prefer-function-type
    <T extends (...args: any) => any>(): sinon.SinonStub<Parameters<T>, ReturnType<T>>;
  }
}

/** Enzyme mount with automatic unmount after the test. */
export const mount: typeof enzyme.mount = (global as any).enzymeMount;

/** Get a iTwinUI Button with a given label */
export function getButtonWithText(container: HTMLElement, label: string, onError?: (msg: string) => void): Element | undefined {
  const selector = "button.iui-button";
  const buttons = container.querySelectorAll(selector);
  if (buttons.length <= 0)
    onError && onError(`Couldn't find any '${selector}' buttons`);

  const button = [...buttons].find((btn) => {
    const span = btn.querySelector("span.iui-label");
    return span!.textContent === label;
  });
  if (!button)
    onError && onError(`No button found with '${label}' label`);

  return button;
}

/**
 * Select component pick value using index
 */
export const selectChangeValueByIndex = (select: HTMLElement, index: number, onError?: (msg: string) => void): void => {
  fireEvent.click(select.querySelector(".iui-select-button") as HTMLElement);

  const menu = select.querySelector(".iui-menu") as HTMLUListElement;
  if (!menu)
    onError && onError(`Couldn't find menu`);
  expect(menu).to.exist;

  const menuItem = menu.querySelectorAll("li");
  if (menuItem[index] === undefined)
    onError && onError(`Couldn't find menu item ${index}`);
  expect(menuItem[index]).to.not.be.undefined;

  fireEvent.click(menuItem[index]);
};

/**
 * Select component change value using text of menu item to find item
 */
export const selectChangeValueByText = (select: HTMLElement, label: string, onError?: (msg: string) => void): void => {
  fireEvent.click(select.querySelector(".iui-select-button") as HTMLElement);

  const menu = select.querySelector(".iui-menu") as HTMLUListElement;
  if (!menu)
    onError && onError(`Couldn't find menu`);
  expect(menu).to.exist;

  const menuItems = menu.querySelectorAll("li span.iui-content");
  if (menuItems.length <= 0)
    onError && onError("Couldn't find any menu items");
  expect(menuItems.length).to.be.greaterThan(0);

  const menuItem = [...menuItems].find((span) => span.textContent === label);
  if (!menuItem)
    onError && onError(`Couldn't find menu item with '${label}' label`);
  expect(menuItem).to.not.be.undefined;

  fireEvent.click(menuItem!);
};

/**
 * Select component test number of options
 */
export const selectTestOptionCount = (select: HTMLElement, expectedCount: number, onError?: (msg: string) => void): void => {
  fireEvent.click(select.querySelector(".iui-select-button") as HTMLElement);

  const menu = select.querySelector(".iui-menu") as HTMLUListElement;
  if (!menu)
    onError && onError(`Couldn't find menu`);
  expect(menu).to.exist;

  const menuItems = menu.querySelectorAll("li span.iui-content");
  if (menuItems.length <= 0)
    onError && onError(`Couldn't find any menu items`);

  expect(menuItems.length).to.eq(expectedCount);

  fireEvent.click(select.querySelector(".iui-select-button") as HTMLElement);
};

/** Handle an error when attempting to get an element */
export function handleError(msg: string) {
  console.log(msg); // eslint-disable-line no-console
}

/** Stubs scrollIntoView. */
export function stubScrollIntoView() {
  const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  const scrollIntoViewMock = function () { };

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  afterEach(() => {
    window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });
}

export default TestUtils;   // eslint-disable-line: no-default-export