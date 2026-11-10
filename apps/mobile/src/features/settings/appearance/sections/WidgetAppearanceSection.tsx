import { useState } from "react";

import { ListToggleRow } from "../../../../components/ui/ListToggleRow";
import { homeWidgetsNative, type HomeWidgetKind } from "../../../../widgets/home/homeWidgetsNative";
import { SettingsSection } from "../../components/SettingsSection";

const WIDGETS: ReadonlyArray<{ readonly kind: HomeWidgetKind; readonly label: string }> = [
  { kind: "working", label: "Working threads" },
  { kind: "recent", label: "Recent threads" },
  { kind: "server", label: "This phone's server" },
  { kind: "actions", label: "Quick actions" },
  { kind: "usage", label: "Usage today" },
  { kind: "prompt", label: "New thread bar" },
  { kind: "gauges", label: "Gauges" },
  { kind: "status", label: "Status line" },
  { kind: "limits", label: "Limits" },
  { kind: "tokens", label: "Tokens today" },
];

export function WidgetAppearanceSection() {
  const native = homeWidgetsNative;
  const [clear, setClear] = useState<ReadonlySet<HomeWidgetKind>>(
    () => new Set(native?.clearBackgrounds() ?? []),
  );
  if (!native) return null;

  const toggle = (kind: HomeWidgetKind, value: boolean) => {
    native.setClearBackground(kind, value);
    setClear((current) => {
      const next = new Set(current);
      if (value) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  return (
    <SettingsSection
      title="Transparent widgets"
      footer="Widgets you turn on here drop their card and show white text with a soft shadow on your wallpaper. The others keep a card that follows light and dark mode."
    >
      {WIDGETS.map(({ kind, label }) => (
        <ListToggleRow
          key={kind}
          label={label}
          value={clear.has(kind)}
          onValueChange={(value) => toggle(kind, value)}
        />
      ))}
    </SettingsSection>
  );
}
