import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../src/components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../src/components/ui/dialog.js";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "../src/components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/components/ui/select.js";
import { applyPalette, type ResolvedTheme } from "../src/theme/applyPalette.js";
import { paletteById } from "../src/theme/palettes.js";

const PALETTE_IDS = ["patrol", "chalk", "telegram"] as const;
const THEMES: readonly ResolvedTheme[] = ["light", "dark"];

function ComponentGallery() {
  return (
    <>
      <Button>Button sample</Button>
      <Card>
        <CardHeader>
          <CardTitle>Card sample</CardTitle>
          <CardDescription>Card description</CardDescription>
        </CardHeader>
        <CardContent>Card content</CardContent>
      </Card>
      <Dialog open modal={false}>
        <DialogTrigger>Dialog trigger</DialogTrigger>
        <DialogContent>
          <DialogTitle>Dialog sample</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>
      <Select open modal={false} value="patrol">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="patrol">Patrol</SelectItem>
          <SelectItem value="chalk">Chalk</SelectItem>
        </SelectContent>
      </Select>
      <Popover open>
        <PopoverTrigger>Popover trigger</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Popover sample</PopoverTitle>
          <PopoverDescription>Popover description</PopoverDescription>
        </PopoverContent>
      </Popover>
    </>
  );
}

describe("local UI component skin", () => {
  for (const paletteId of PALETTE_IDS) {
    for (const theme of THEMES) {
      it(`renders every initial component with ${paletteId} ${theme} tokens`, () => {
        const palette = paletteById(paletteId);
        const ramp = theme === "dark" ? palette.d : palette.l;
        applyPalette({ root: document.documentElement, palette, appearance: theme });

        render(<ComponentGallery />);

        expect(document.documentElement).toHaveAttribute("data-theme", theme);
        expect(document.documentElement.style.getPropertyValue("--bg")).toBe(ramp.bg);
        expect(document.documentElement.style.getPropertyValue("--brand")).toBe(ramp.br);
        expect(document.querySelector('[data-slot="button"]')).toHaveClass("h-ctl", "rounded-ctl");
        expect(document.querySelector('[data-slot="card"]')).toHaveClass(
          "rounded-card",
          "border-border",
        );
        for (const slot of ["dialog-content", "select-content", "popover-content"]) {
          expect(document.querySelector(`[data-slot="${slot}"]`)).toHaveClass(
            "rounded-card",
            "border-line-2",
            "shadow-elev-3",
          );
        }
      });
    }
  }
});
