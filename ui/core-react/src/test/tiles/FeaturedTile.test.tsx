/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { render } from "@testing-library/react";
import { expect } from "chai";
import * as React from "react";
import { FeaturedTile } from "../../core-react";
import { classesFromElement } from "../TestUtils";

/* eslint-disable deprecation/deprecation */

describe("<FeaturedTile />", () => {
  const icon = <i className="icon icon-placeholder" />;

  it("renders correctly", () => {
    const {container} = render(<FeaturedTile title="Test" icon={icon} />);

    expect(classesFromElement(container.firstElementChild)).to.include("uicore-featured");
  });
});