/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module IModelComponents
 */

/* eslint-disable deprecation/deprecation */

import * as React from "react";
import { IPresentationTreeDataProvider, useControlledPresentationTreeFiltering } from "@itwin/presentation-components";
import {
  AbstractTreeNodeLoaderWithProvider, TreeImageLoader, TreeNodeRenderer, TreeNodeRendererProps, TreeRenderer, TreeRendererProps,
} from "@itwin/components-react";
import { ImageCheckBox, NodeCheckboxRenderProps } from "@itwin/core-react";
import { VisibilityTreeFilterInfo } from "./Common";

/**
 * Creates Visibility tree renderer which renders nodes with eye checkbox.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export const useVisibilityTreeRenderer = (iconsEnabled: boolean, descriptionsEnabled: boolean) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodeRenderer = React.useCallback(createVisibilityTreeNodeRenderer(iconsEnabled, descriptionsEnabled), [iconsEnabled, descriptionsEnabled]);
  return React.useCallback((props: TreeRendererProps) => (
    <TreeRenderer
      {...props}
      nodeRenderer={nodeRenderer}
    />
  ), [nodeRenderer]);
};

const imageLoader = new TreeImageLoader();
/**
 * Creates node renderer which renders node with eye checkbox.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export const createVisibilityTreeNodeRenderer = (iconsEnabled: boolean, descriptionEnabled: boolean) => {
  return (props: TreeNodeRendererProps) => ( // eslint-disable-line react/display-name
    <TreeNodeRenderer
      {...props}
      checkboxRenderer={visibilityTreeNodeCheckboxRenderer}
      descriptionEnabled={descriptionEnabled}
      imageLoader={iconsEnabled ? imageLoader : undefined}
      className="with-checkbox"
    />
  );
};

/**
 * Checkbox renderer that renders an eye.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export const visibilityTreeNodeCheckboxRenderer = (props: NodeCheckboxRenderProps) => (
  <ImageCheckBox
    checked={props.checked}
    disabled={props.disabled}
    imageOn="icon-visibility"
    imageOff="icon-visibility-hide-2"
    onClick={props.onChange}
    tooltip={props.title}
  />
);

/**
 * Filters data provider used in supplied node loader and invokes onFilterApplied when filtering is completed.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export const useVisibilityTreeFiltering = (
  nodeLoader: AbstractTreeNodeLoaderWithProvider<IPresentationTreeDataProvider>,
  filterInfo?: VisibilityTreeFilterInfo,
  onFilterApplied?: (filteredDataProvider: IPresentationTreeDataProvider, matchesCount: number) => void,
) => {
  const { filter, activeMatchIndex } = filterInfo ?? { filter: undefined, activeMatchIndex: undefined };
  const {
    filteredNodeLoader,
    isFiltering,
    matchesCount,
    nodeHighlightingProps,
  } = useControlledPresentationTreeFiltering({ nodeLoader, filter, activeMatchIndex });

  React.useEffect(
    () => {
      if (filter && matchesCount !== undefined && filteredNodeLoader !== nodeLoader)
        onFilterApplied && onFilterApplied(filteredNodeLoader.dataProvider, matchesCount);
    },
    [filter, matchesCount, nodeLoader, filteredNodeLoader, onFilterApplied],
  );

  return { filteredNodeLoader, isFiltering, nodeHighlightingProps };
};

/**
 * Properties for [[VisibilityTreeNoFilteredData]] component.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export interface VisibilityTreeNoFilteredDataProps {
  title: string;
  message: string;
}

/**
 * Renders message that no nodes was found for filter.
 * @alpha
 * @deprecated in 3.6. Was moved to `@itwin/tree-widget-react` package.
 */
export function VisibilityTreeNoFilteredData(props: VisibilityTreeNoFilteredDataProps) {
  return (
    <div className="components-tree-errormessage">
      <span className="errormessage-header">{props.title}</span>
      <span className="errormessage-body">{props.message}</span>
    </div>
  );
}