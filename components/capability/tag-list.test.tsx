// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TagList } from "./tag-list";

afterEach(cleanup);

const tags = ["rag", "web-scraping", "python", "cli", "agents"];

describe("TagList", () => {
  it("renders every tag when no cap is given", () => {
    const { container } = render(<TagList tags={tags} />);
    expect([...container.querySelectorAll(".tag")].map((el) => el.textContent)).toEqual(tags);
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<TagList tags={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows at most `max` tags and folds the rest into a +N remainder", () => {
    const { container } = render(<TagList tags={tags} max={3} />);
    const items = [...container.querySelectorAll("li")].map((el) => el.textContent);
    expect(items).toEqual(["rag", "web-scraping", "python", "+2"]);
    expect(container.querySelector(".tag--more")?.textContent).toBe("+2");
    expect(container.querySelector(".tag--more")?.getAttribute("title")).toBe("cli、agents");
  });

  it("omits the remainder when the list exactly fits the cap", () => {
    const { container } = render(<TagList tags={tags.slice(0, 3)} max={3} />);
    expect(container.querySelectorAll("li").length).toBe(3);
    expect(container.querySelector(".tag--more")).toBeNull();
  });

  it("de-emphasises the chips when quiet is set", () => {
    const { container } = render(<TagList tags={tags} quiet />);
    expect(container.querySelector("ul")?.className).toContain("tag-list--quiet");
  });
});
