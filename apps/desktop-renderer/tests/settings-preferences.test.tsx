import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsView } from "../src/ui/settings/SettingsView";
import { useEnduragentStore } from "../src/state/store";
import { PALETTES } from "@enduragent/ui";
import { APPEARANCE_STORAGE_KEY, PALETTE_STORAGE_KEY } from "../src/theme/preferences";
import { setPrefersDark } from "./matchmedia";

function resetStore(): void {
  useEnduragentStore.setState({ paletteId: "patrol", appearance: "system", theme: "light" });
}

describe("settings preferences", () => {
  beforeEach(() => {
    resetStore();
  });

  it("offers one swatch per palette and marks the active one", () => {
    render(<SettingsView />);

    const swatches = screen.getAllByRole("button", { name: /^Use the .+ palette$/u });
    expect(swatches).toHaveLength(PALETTES.length);
    for (const swatch of swatches) {
      expect(swatch).toHaveClass("h-auto", "items-stretch");
      expect(swatch).not.toHaveClass("h-ctl");
      expect(swatch.firstElementChild).toHaveClass("h-10");
    }
    expect(screen.getByRole("button", { name: "Use the Patrol palette" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("applies and persists a palette choice", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByRole("button", { name: "Use the Cobalt palette" }));

    expect(useEnduragentStore.getState().paletteId).toBe("cobalt");
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("cobalt");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#1b4ed8");
    expect(screen.getByRole("button", { name: "Use the Cobalt palette" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Use the Patrol palette" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("applies and persists an appearance choice", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const group = screen.getByRole("group", { name: "Appearance" });

    await user.click(screen.getByRole("button", { name: "Dark" }));

    expect(useEnduragentStore.getState().appearance).toBe("dark");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0f1520");
    expect(group).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Light" }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f2f5f8");
  });

  it("follows the system colour scheme when the appearance is System", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    setPrefersDark(true);
    await user.click(screen.getByRole("button", { name: "System" }));

    expect(useEnduragentStore.getState().appearance).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
