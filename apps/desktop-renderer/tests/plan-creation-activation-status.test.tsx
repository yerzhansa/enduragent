import { renderLocalized as render } from "./language-harness";
import { describe, expect, it } from "vitest";
import { PlanCreationConversation } from "../src/ui/chat/PlanCreationCards";

describe("Plan creation activation status", () => {
  it("renders no transcript content after activation", () => {
    const { container } = render(<PlanCreationConversation model={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
