import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Alert, Button, Group, Loader, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import {
  PAIRING_PREFIX,
  ago,
  cancelPairing,
  copyLine,
  copyState,
  createPairingCode,
  describeHeld,
  getSyncStatus,
  isAndroid,
  joinBook,
  onSyncStatus,
  removeDevice,
  setDeviceName,
  syncNow,
} from "../lib/sync";
import type { SyncDevice, SyncStatus } from "../lib/sync";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Spec: SYN-9
/** Scans a QR code with the phone's camera, through the barcode plugin. */
async function scanWithPhone(): Promise<string | null> {
  const { scan, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let perm = await checkPermissions();
  if (perm !== "granted") perm = await requestPermissions();
  if (perm !== "granted") throw new Error("My Book needs the camera to scan the code.");
  const r = await scan({ formats: [Format.QRCode], windowed: false });
  return r.content || null;
}

function DeviceRow({ d, onRemove }: { d: SyncDevice; onRemove: (d: SyncDevice) => void }) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <div>
        <Text fw={500}>
          {d.name}{" "}
          <Text span c="dimmed" size="sm">
            · {d.platform === "android" ? "phone" : "computer"}
          </Text>
        </Text>
        <Text size="sm" c="dimmed">
          {d.lastSyncAt
            ? `Synced ${ago(d.lastSyncAt)}${d.complete ? " · identical" : " · not identical yet"}`
            : "Not synced yet"}
        </Text>
      </div>
      <Button variant="subtle" size="xs" color="red" onClick={() => onRemove(d)}>
        Remove
      </Button>
    </Group>
  );
}

/** A question asked in place, instead of a native dialog (which the desktop app doesn't show). */
function Confirm(props: { text: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Alert color="orange" variant="light">
      <Text size="sm" style={{ whiteSpace: "pre-line" }} mb="sm">
        {props.text}
      </Text>
      <Group gap="xs">
        <Button size="xs" color="red" onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
        <Button size="xs" variant="default" onClick={props.onCancel}>
          Cancel
        </Button>
      </Group>
    </Alert>
  );
}

/**
 * Sync: this device's name, the book's other devices, pairing a new one (a QR
 * code to scan, or the same code copied and pasted between two computers),
 * and joining another device's book.
 */
export default function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joining, setJoining] = useState<"idle" | "working">("idle");
  const [pasted, setPasted] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  /** The author agreed to replace what this device holds (a copy is saved first). */
  const [replace, setReplace] = useState(false);
  const [asking, setAsking] = useState<null | { kind: "replace" } | { kind: "remove"; device: SyncDevice }>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getSyncStatus();
      setStatus(s);
      setName((n) => n || s.name);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = onSyncStatus(() => void refresh());
    // Device lists and "synced N min ago" move on their own.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [refresh]);

  // Leaving the page takes the code down.
  useEffect(() => () => void cancelPairing().catch(() => {}), []);

  async function showCode() {
    setError(null);
    try {
      const c = await createPairingCode();
      setCode(c);
      setCopied(false);
      setQr(await QRCode.toDataURL(c, { margin: 1, width: 320, errorCorrectionLevel: "M" }));
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function hideCode() {
    await cancelPairing().catch(() => {});
    setCode(null);
    setQr(null);
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch (e) {
      setError(`Couldn't copy the code (${errMsg(e)}).`);
    }
  }

  const join = useCallback(
    async (c: string) => {
      setJoining("working");
      setError(null);
      try {
        const { outcome, backup } = await joinBook(c, replace);
        setJoined(
          (outcome.complete
            ? `Joined ${outcome.peer_name}'s book: everything is here.`
            : `Joined ${outcome.peer_name}'s book; the rest follows on the next sync.`) +
            (backup ? ` What this device held before is saved at ${backup}.` : ""),
        );
        setReplace(false);
        setPasted("");
        void refresh();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setJoining("idle");
      }
    },
    [refresh, replace],
  );

  async function scan() {
    setError(null);
    try {
      const c = await scanWithPhone();
      if (c) await join(c);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function saveName() {
    const n = name.trim();
    if (!n || n === status?.name) return;
    try {
      await setDeviceName(n);
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function remove(d: SyncDevice) {
    setAsking(null);
    try {
      await removeDevice(d.id);
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const others = status?.devices.filter((d) => !d.isSelf) ?? [];
  const state = status ? copyState(status) : null;
  // A device became identical while the code was up: the pairing worked.
  const paired = code !== null && others.some((d) => d.lastCompleteAt && Date.now() - Date.parse(d.lastCompleteAt) < 60_000);
  const android = isAndroid();

  return (
    <div className="screen">
      <Title order={1} mb="xs">
        Sync
      </Title>
      <Text c="dimmed" size="sm" mb="lg">
        Your devices keep one shared copy of the book, synced directly over the local network whenever they can see each
        other. Nothing goes through a server. A computer also keeps a copy of the whole database every day for two weeks,
        then one a week for about three months.
      </Text>

      {error && (
        <Alert color="red" variant="light" mb="md" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {status === null ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="lg">
          {state && state.kind !== "none" && (
            <Paper withBorder p="md" radius="md">
              <Text size="sm" mb="xs">
                {copyLine(state)}
              </Text>
              {status.lastError && (
                <Text size="sm" c="dimmed" mb="xs">
                  Last problem: {status.lastError}
                </Text>
              )}
              <Button size="xs" variant="default" onClick={() => void syncNow()} loading={status.syncing}>
                Sync now
              </Button>
            </Paper>
          )}

          <Paper withBorder p="md" radius="md">
            <TextInput
              label="This device"
              description="What the other devices call it."
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.currentTarget.value)}
              onBlur={() => void saveName()}
            />
          </Paper>

          {others.length > 0 && (
            <Paper withBorder p="md" radius="md">
              <Title order={3} size="h5" mb="sm">
                Devices of this book
              </Title>
              <Stack gap="sm">
                {others.map((d) =>
                  asking?.kind === "remove" && asking.device.id === d.id ? (
                    <Confirm
                      key={d.id}
                      text={`Remove ${d.name} from the book? It stops syncing; what it already has stays on it.`}
                      confirmLabel="Remove"
                      onConfirm={() => void remove(d)}
                      onCancel={() => setAsking(null)}
                    />
                  ) : (
                    <DeviceRow key={d.id} d={d} onRemove={(x) => setAsking({ kind: "remove", device: x })} />
                  ),
                )}
              </Stack>
            </Paper>
          )}

          <Paper withBorder p="md" radius="md">
            <Title order={3} size="h5" mb="sm">
              Add a device
            </Title>
            {code && qr ? (
              <>
                <Text size="sm" {...(paired ? {} : { c: "dimmed" })} mb="sm">
                  {paired
                    ? "Paired. The new device has a full copy."
                    : "On the other device, open Sync and scan this, or copy the code and paste it there. It works once, for ten minutes, on this network."}
                </Text>
                <img
                  src={qr}
                  alt="Pairing code"
                  style={{ width: "100%", maxWidth: 320, display: "block", margin: "0 auto 12px", borderRadius: 8, background: "#fff" }}
                />
                <Group gap="xs">
                  <Button size="xs" variant="default" onClick={() => void copyCode()}>
                    {copied ? "Copied" : "Copy code"}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => void hideCode()}>
                    Done
                  </Button>
                </Group>
              </>
            ) : (
              <>
                <Text size="sm" c="dimmed" mb="sm">
                  Shows a code for the other device. That device must have an empty book; it gets a full copy of this one.
                </Text>
                <Button size="xs" onClick={() => void showCode()}>
                  Show pairing code
                </Button>
              </>
            )}
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Title order={3} size="h5" mb="sm">
              Join another device's book
            </Title>
            {joined ? (
              <Text size="sm">{joined}</Text>
            ) : asking?.kind === "replace" ? (
              <Confirm
                text={
                  `This device holds ${describeHeld(status.held)}. Joining replaces all of it with the other device's book.\n\n` +
                  "A complete copy of this device's database is saved first, in the app's backups folder, so nothing is lost."
                }
                confirmLabel="Replace and join"
                onConfirm={() => {
                  setReplace(true);
                  setAsking(null);
                }}
                onCancel={() => setAsking(null)}
              />
            ) : !status.canJoin && !replace ? (
              <>
                <Text size="sm" c="dimmed" mb="sm">
                  This device holds {describeHeld(status.held)}, so joining would replace it. If this is the device with your
                  book, show the pairing code here and join from the other device instead. If what's here doesn't matter,
                  replace it: a copy is saved first.
                </Text>
                <Button size="xs" variant="default" onClick={() => setAsking({ kind: "replace" })}>
                  Replace this device's data and join…
                </Button>
              </>
            ) : joining === "working" ? (
              <Group gap="sm">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  Copying everything over…
                </Text>
              </Group>
            ) : (
              <>
                <Text size="sm" c="dimmed" mb="sm">
                  {replace
                    ? "Use the code the other device shows, on the same network. What's here is saved to a backup, then replaced by the other device's book."
                    : "Use the code the other device shows, on the same network. This device is empty, so it simply becomes a copy of it."}
                </Text>
                <Group gap="xs" mb="sm">
                  {android && (
                    <Button size="xs" onClick={() => void scan()}>
                      Scan code
                    </Button>
                  )}
                  {replace && (
                    <Button size="xs" variant="subtle" onClick={() => setReplace(false)}>
                      Keep what's here
                    </Button>
                  )}
                </Group>
                <Group gap="xs" wrap="nowrap" align="flex-end">
                  <TextInput
                    style={{ flex: 1 }}
                    placeholder={android ? "…or paste the code" : "Paste the code"}
                    value={pasted}
                    onChange={(e) => setPasted(e.currentTarget.value)}
                  />
                  <Button size="sm" disabled={!pasted.trim().startsWith(PAIRING_PREFIX)} onClick={() => void join(pasted.trim())}>
                    Join
                  </Button>
                </Group>
              </>
            )}
          </Paper>

          {status.lastRoundAt && (
            <Text size="xs" c="dimmed" ta="center">
              Last looked for devices {ago(status.lastRoundAt)}
            </Text>
          )}
        </Stack>
      )}
    </div>
  );
}
