// Lifecycle sensor (migration plan M2, ADR-0039): the only code that detects a shortcut
// starting and quitting. Emits shortcut.launched / shortcut.quit on the bus.
import { onAppLaunch } from "steambrew-utils/watchers";
import { toShortcutId } from "../../kernel/appid";
import type { EventBus } from "../../kernel/events";

let installed = false;

export function installLifecycleSensor(bus: EventBus): void {
    if (installed) return;
    installed = true;

    onAppLaunch((app, { onQuit }) => {
        const appid = toShortcutId(app.appid);
        if (appid === undefined) return;
        const name = String(app.display_name ?? appid);
        bus.emit("shortcut.launched", { appid, name });
        onQuit(() => bus.emit("shortcut.quit", { appid, name }));
    });
}
