import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListRow } from "../../../../components/ui/ListRow";
import { cn } from "../../../../lib/cn";
import {
  APP_ICON_PRESETS,
  pickSquarePicture,
  pinCustomAppIcon,
  removeCustomAppIcon,
  setAppIcon,
  useAppIconState,
  type PinCustomIconResult,
} from "../../../app-icon/appIconModule";
import { SettingsSection } from "../../components/SettingsSection";

// Android's adaptive icon squircle is close to a 30% corner radius at launcher sizes.
const SQUIRCLE_RADIUS = 0.3;

const PIN_MESSAGES: Record<PinCustomIconResult, string> = {
  requested: "Confirm in the prompt to add the shortcut to your home screen.",
  updated: "Your home screen shortcut now uses this picture.",
  unsupported: "Your launcher does not let apps add home screen shortcuts.",
};

function PresetTile(props: {
  readonly label: string;
  readonly preview: (typeof APP_ICON_PRESETS)[number]["preview"];
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label} app icon`}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "w-[30%] grow items-center gap-2 rounded-[24px] py-3 active:scale-[0.96]",
        props.selected ? "border-2 border-primary bg-subtle" : "border border-transparent",
      )}
      onPress={props.onPress}
    >
      <Image
        accessibilityIgnoresInvertColors
        source={props.preview}
        style={{ width: 60, height: 60, borderRadius: 60 * SQUIRCLE_RADIUS }}
      />
      <Text
        className={cn(
          "text-sm",
          props.selected ? "font-t3-bold text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function MaskPreview(props: { readonly uri: string }) {
  const size = 72;
  return (
    <View className="flex-row items-center justify-center gap-6 py-4">
      {[size / 2, size * SQUIRCLE_RADIUS].map((radius) => (
        <Image
          accessibilityIgnoresInvertColors
          key={radius}
          source={{ uri: props.uri }}
          style={{ width: size, height: size, borderRadius: radius }}
        />
      ))}
    </View>
  );
}

export function AppIconAppearanceSection() {
  const state = useAppIconState();
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!state) return null;

  const errorText = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  const choosePicture = () => {
    setMessage(null);
    pickSquarePicture().then(
      (uri) => {
        if (uri) setPicked(uri);
      },
      (error: unknown) => setMessage(errorText(error, "Could not open your photos.")),
    );
  };

  const pin = () => {
    const uri = picked ?? state.customImage;
    if (!uri) return;
    setBusy(true);
    pinCustomAppIcon(uri)
      .then(
        (result) => {
          setMessage(PIN_MESSAGES[result]);
          setPicked(null);
        },
        (error: unknown) => setMessage(errorText(error, "Could not add the shortcut.")),
      )
      .finally(() => setBusy(false));
  };

  const remove = () => {
    const wasPinned = state.customPinned;
    setBusy(true);
    removeCustomAppIcon()
      .then(
        () => {
          setPicked(null);
          setMessage(
            wasPinned
              ? "The shortcut is turned off. Long-press it on your home screen to remove it there."
              : null,
          );
        },
        (error: unknown) => setMessage(errorText(error, "Could not remove the shortcut.")),
      )
      .finally(() => setBusy(false));
  };

  const previewUri = picked ?? state.customImage;
  return (
    <>
      <SettingsSection
        title="App icon"
        footer="The new icon takes effect when you leave the app, and your launcher can take a few seconds to show it. Some launchers move or remove the app's home screen icon when it changes; add it again from the app drawer."
      >
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2 p-3">
          {APP_ICON_PRESETS.filter((preset) => state.presets.includes(preset.id)).map((preset) => (
            <PresetTile
              key={preset.id}
              label={preset.label}
              preview={preset.preview}
              selected={preset.id === state.icon}
              onPress={() => {
                if (preset.id !== state.icon) setAppIcon(preset.id);
              }}
            />
          ))}
        </View>
      </SettingsSection>

      <SettingsSection
        title="Your own picture"
        footer={
          state.pinSupported
            ? "Android does not let apps use any picture as their real icon, so this adds a home screen shortcut that opens T3² code. Some launchers add a small app badge to it. The app drawer keeps the icon chosen above."
            : "Your launcher does not let apps add home screen shortcuts, so a picture of your own cannot be used."
        }
      >
        {previewUri ? <MaskPreview uri={previewUri} /> : null}
        {message ? (
          <Text className="px-4 pb-3 text-sm text-foreground-muted">
            {message === PIN_MESSAGES.requested && state.customPinned
              ? "Added to your home screen."
              : message}
          </Text>
        ) : null}
        <ListRow
          icon="photo"
          label={previewUri ? "Choose another picture" : "Choose a picture"}
          description="Crop it to a square. The round and rounded previews show how launchers mask it."
          disabled={!state.pinSupported || busy}
          onPress={choosePicture}
        />
        {previewUri && (picked || !state.customPinned) ? (
          <ListRow
            icon="square.grid.2x2"
            label={state.customPinned ? "Update home screen shortcut" : "Add to home screen"}
            disabled={!state.pinSupported || busy}
            onPress={pin}
          />
        ) : null}
        {state.customPinned || state.customImage ? (
          <ListRow
            icon="trash"
            label={state.customPinned ? "Remove shortcut" : "Delete saved picture"}
            disabled={busy}
            onPress={remove}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
