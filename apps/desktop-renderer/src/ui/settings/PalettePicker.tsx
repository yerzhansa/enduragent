import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { cn } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { PALETTES } from "@enduragent/ui";

export function PalettePicker(): ReactElement {
  const paletteId = useEnduragentStore((state) => state.paletteId);
  const setPaletteId = useEnduragentStore((state) => state.setPaletteId);

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3 px-4 py-3.5"
      role="group"
      aria-label="App palette"
    >
      {PALETTES.map((palette) => (
        <Button
          key={palette.id}
          type="button"
          variant="ghost"
          className="flex h-auto cursor-pointer flex-col items-stretch gap-1.5 rounded-ctl border-0 bg-transparent p-0 font-inherit"
          aria-pressed={palette.id === paletteId}
          aria-label={`Use the ${palette.name} palette`}
          onClick={() => {
            setPaletteId(palette.id);
          }}
        >
          <span
            className={cn(
              "flex h-10 overflow-hidden rounded-ctl border border-line-2 shadow-elev-1",
              palette.id === paletteId && "outline-2 outline-offset-2 outline-ink",
            )}
            aria-hidden="true"
          >
            <span className="grid flex-1 place-items-center" style={{ background: palette.l.bg }}>
              <span className="block size-3 rounded-full" style={{ background: palette.l.br }} />
            </span>
            <span className="grid flex-1 place-items-center" style={{ background: palette.d.bg }}>
              <span className="block size-3 rounded-full" style={{ background: palette.d.br }} />
            </span>
          </span>
          <span
            className={cn(
              "text-center text-[11.5px] text-ink-2",
              palette.id === paletteId && "font-semibold text-ink",
            )}
          >
            {palette.name}
          </span>
        </Button>
      ))}
    </div>
  );
}
