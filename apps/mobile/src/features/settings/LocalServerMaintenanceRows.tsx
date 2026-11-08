import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { Progress } from "../../components/ui/Progress";
import { maintenanceOutcome, maintenanceProgress } from "../local-server/backupManifest";
import {
  backUpLinux,
  cancelMaintenance,
  dismissMaintenanceResult,
  resetLinux,
  restoreLinux,
  useLinuxMaintenance,
} from "../local-server/linuxMaintenance";
import type { LocalServerState } from "../local-server/localServerModule";

/** Backup, restore and reset rows, with the running job's progress in place of the buttons. */
export function LocalServerMaintenanceRows(props: { readonly state: LocalServerState }) {
  const job = useLinuxMaintenance();
  const installed = props.state !== "notInstalled" && props.state !== "installing";
  if (job?.state === "running") {
    const progress = maintenanceProgress(job);
    const title = job.operation === "backup" ? "Backing up Linux" : "Restoring Linux";
    return (
      <>
        <View className="gap-2 p-4">
          <Text className="text-base text-foreground">{title}</Text>
          <Progress value={progress.fraction} label={title} />
          <Text className="text-sm text-foreground-muted">{progress.label}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {job.detail}
          </Text>
        </View>
        <SettingsActionRow icon="xmark" label="Cancel" onPress={cancelMaintenance} />
      </>
    );
  }
  const outcome = job ? maintenanceOutcome(job) : null;
  return (
    <>
      {outcome ? (
        <View className="gap-1 p-4">
          <Text
            selectable
            accessibilityRole={job?.state === "failed" ? "alert" : undefined}
            className={
              job?.state === "failed" ? "text-sm text-danger-foreground" : "text-sm text-foreground"
            }
          >
            {outcome}
          </Text>
        </View>
      ) : null}
      {outcome ? (
        <SettingsActionRow icon="checkmark" label="Dismiss" onPress={dismissMaintenanceResult} />
      ) : null}
      <SettingsActionRow
        icon="tray.and.arrow.down"
        label="Back up Linux"
        description="One file with Linux, projects and Claude sign-in"
        disabled={!installed}
        onPress={() => void backUpLinux()}
      />
      <SettingsActionRow
        icon="tray.and.arrow.up"
        label="Restore from backup"
        disabled={props.state === "installing"}
        onPress={() => void restoreLinux()}
      />
      <SettingsActionRow
        icon="arrow.uturn.backward"
        label="Reset Linux"
        description="Fresh Linux; keeps projects and Claude sign-in"
        disabled={!installed}
        onPress={() => void resetLinux()}
      />
    </>
  );
}
