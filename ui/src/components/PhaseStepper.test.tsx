// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhaseStepper } from "./PhaseStepper";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const phases = ["Requirements", "Design", "Release"].map((name) => ({ key: name.toLowerCase(), name }));

describe("PhaseStepper", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function states(props: Parameters<typeof PhaseStepper>[0]) {
    const root = createRoot(container);
    flushSync(() => root.render(<PhaseStepper {...props} />));
    const items = [...container.querySelectorAll("li")];
    root.unmount();
    return items.map((item) => [item.textContent?.replace("(current phase)", "").trim(), item.dataset.state, item.getAttribute("aria-current")]);
  }

  it("marks earlier phases done, the current one as the step, and later ones upcoming", () => {
    expect(states({ phases, currentKey: "design" })).toEqual([
      ["Requirements", "done", null],
      ["Design", "current", "step"],
      ["Release", "upcoming", null],
    ]);
  });

  it("shows every phase done once the final phase is completed", () => {
    expect(states({ phases, currentKey: "release", completed: true }).map((row) => row[1])).toEqual(["done", "done", "done"]);
  });
});
