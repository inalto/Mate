import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WhatsNew from "../WhatsNew";

describe("WhatsNew inline markdown", () => {
  it("renders **bold** as <strong> and `code` as <code>, without the markers", () => {
    render(<WhatsNew notes={"## Touch\n\n- **Pinch** to zoom (**Shift+L**) with `code`.\n"} onClose={() => {}} />);
    const strong = screen.getAllByText((_, el) => el?.tagName === "STRONG" && !!el.textContent);
    expect(strong.map((e) => e.textContent)).toEqual(["Pinch", "Shift+L"]);
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(document.body.textContent).not.toContain("**");
    expect(document.body.textContent).not.toContain("`");
  });
});
