import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Toast } from "../../components/ui/Toast";
import { dismissFileDownloadNotice, useFileDownloadNotice } from "../../lib/fileDownload";

const TAB_BAR_CLEARANCE = 96;

export function FileDownloadNotice() {
  const notice = useFileDownloadNotice();
  const insets = useSafeAreaInsets();
  if (notice === null) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-3 right-3"
      style={{ bottom: insets.bottom + TAB_BAR_CLEARANCE }}
    >
      {notice.tone === "busy" ? (
        <Toast
          busy
          message={`Downloading ${notice.name}`}
          {...(notice.progress === null
            ? {}
            : { description: `${Math.round(notice.progress * 100)}%` })}
        />
      ) : notice.tone === "success" ? (
        <Toast
          tone="success"
          message="Saved to Downloads"
          description={`T3² code/${notice.name}`}
          onDismiss={dismissFileDownloadNotice}
        />
      ) : (
        <Toast
          tone="danger"
          message={`Could not download ${notice.name}`}
          description={notice.message}
          onDismiss={dismissFileDownloadNotice}
        />
      )}
    </View>
  );
}
