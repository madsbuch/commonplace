import { BackToSettings } from "../components/SettingsRows";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { createPortal } from "react-dom";
import { InfoButton } from "../components/InfoButton";
import { MoreMenu } from "../components/MoreMenu";
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
import { useNotedProblem } from "../lib/diagnostics";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Spec: SYN-9
/**
 * Scans a QR code with the phone's camera, through the barcode plugin. The
 * camera shows behind the app (`windowed`), which steps aside for it
 * (`phone-scanning` on <html>) and draws a frame and a Cancel button over it:
 * the plugin's own full-screen view has no way back. Cancelled: null.
 */
async function scanWithPhone(): Promise<string | null> {
  const { scan, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let perm = await checkPermissions();
  if (perm !== "granted") perm = await requestPermissions();
  if (perm !== "granted") throw new Error("Commonplace needs the camera to scan the code.");
  document.documentElement.classList.add("phone-scanning");
  try {
    const r = await scan({ formats: [Format.QRCode], windowed: true });
    return r.content || null;
  } catch (e) {
    if (errMsg(e).includes("cancelled")) return null;
    throw e;
  } finally {
    document.documentElement.classList.remove("phone-scanning");
  }
}

async function cancelPhoneScan(): Promise<void> {
  const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
  await cancel().catch(() => undefined);
}

/** Over the phone's camera while it scans: where to aim, and a way out. */
function PhoneScanOverlay() {
  return createPortal(
    <div className="phone-scan-overlay">
      <div className="phone-scan-frame" />
      <p>Point the camera at the code on the other device.</p>
      <button type="button" onClick={() => void cancelPhoneScan()}>
        Cancel
      </button>
    </div>,
    document.body,
  );
}

// Spec: SYN-21
/** The computer's webcam, read frame by frame until a pairing code shows up (as in Tally). */
function WebcamScanner({ onCode, onError }: { onCode: (c: string) => void; onError: (e: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (done) return;
      const v = video.current;
      if (v && ctx && v.readyState >= 2 && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height);
        if (hit?.data.startsWith(PAIRING_PREFIX)) {
          done = true;
          onCode(hit.data);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices) {
      onError("There's no camera here. Paste the code instead.");
    } else {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
        .then((s) => {
          if (done) {
            s.getTracks().forEach((tr) => tr.stop());
            return;
          }
          stream = s;
          if (video.current) {
            video.current.srcObject = s;
            void video.current.play();
          }
          frame = requestAnimationFrame(tick);
        })
        .catch((e: unknown) => onError(`The camera isn't available (${errMsg(e)}). Paste the code instead.`));
    }
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onCode, onError]);
  return <video ref={video} className="pairing-camera" muted playsInline />;
}

/** A pairing code as a QR code: SVG, so it's sharp at any size, with the standard quiet zone. */
async function qrImage(code: string): Promise<string> {
  const svg = await QRCode.toString(code, { type: "svg", margin: 4, errorCorrectionLevel: "L", color: { dark: "#000000", light: "#ffffff" } });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
      {/* Spec: APP-12 */}
      <MoreMenu label={`More for ${d.name}`} actions={[{ label: "Remove from the book", danger: true, onClick: () => onRemove(d) }]} />
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
 * code to scan, or the same code copied and pasted), and joining another
 * device's book. Either side can scan: a phone with its camera, a computer
 * with its webcam.
 */
export default function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  // Spec: DIAG-1
  const [error, setError] = useNotedProblem("sync");
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joining, setJoining] = useState<"idle" | "scanning" | "working">("idle");
  const [pasted, setPasted] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  /** A code in hand on a device that holds data: joining waits for the author's yes. */
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SyncDevice | null>(null);
  const android = isAndroid();

  const refresh = useCallback(async () => {
    try {
      const s = await getSyncStatus();
      setStatus(s);
      setName((n) => n || s.name);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [setError]);

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
      setQr(await qrImage(c));
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
    async (c: string, replace: boolean) => {
      setJoining("working");
      setPending(null);
      setError(null);
      try {
        const { outcome, backup } = await joinBook(c, replace);
        setJoined(
          (outcome.complete
            ? `Joined ${outcome.peer_name}'s book: everything is here.`
            : `Joined ${outcome.peer_name}'s book; the rest follows on the next sync.`) +
            (backup ? ` What this device held before is saved at ${backup}.` : ""),
        );
        setPasted("");
        void refresh();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setJoining("idle");
      }
    },
    [refresh, setError],
  );

  // Spec: SYN-9, SYN-22
  /** A code in hand: an empty device joins at once; one holding data asks first. */
  const takeCode = useCallback(
    (raw: string) => {
      const c = raw.trim();
      setJoining("idle");
      setError(null);
      if (!c.startsWith(PAIRING_PREFIX)) {
        setError("That isn't a Commonplace pairing code.");
        return;
      }
      if (status?.canJoin) void join(c, false);
      else setPending(c);
    },
    [status?.canJoin, join, setError],
  );
  const scanFailed = useCallback((e: string) => {
    setJoining("idle");
    setError(e);
  }, [setError]);

  async function scan() {
    setError(null);
    if (!android) {
      setJoining("scanning");
      return;
    }
    setJoining("scanning");
    try {
      const c = await scanWithPhone();
      if (c) takeCode(c);
      else setJoining("idle");
    } catch (e) {
      setJoining("idle");
      setError(errMsg(e));
    }
  }

  // Leaving the page while the camera is up puts it away.
  useEffect(() => {
    if (!android || joining !== "scanning") return;
    return () => void cancelPhoneScan();
  }, [android, joining]);

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
    setRemoving(null);
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

  return (
    <div className="screen">
      <BackToSettings />
      <div className="with-info" style={{ marginBottom: 16 }}>
        <Title order={1}>Sync</Title>
        {/* Spec: APP-9 */}
        <InfoButton title="Sync">
          <p>
            Your devices keep one shared copy of the book, synced directly over the local network whenever they can see each other.
            Nothing goes through a server.
          </p>
          <p>A computer also keeps a copy of the whole database every day for two weeks, then one a week for about three months.</p>
        </InfoButton>
      </div>

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
              label="This device's name"
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
                  removing?.id === d.id ? (
                    <Confirm
                      key={d.id}
                      text={`Remove ${d.name} from the book? It stops syncing; what it already has stays on it.`}
                      confirmLabel="Remove"
                      onConfirm={() => void remove(d)}
                      onCancel={() => setRemoving(null)}
                    />
                  ) : (
                    <DeviceRow key={d.id} d={d} onRemove={setRemoving} />
                  ),
                )}
              </Stack>
            </Paper>
          )}

          <Paper withBorder p="md" radius="md">
            <div className="with-info" style={{ marginBottom: 8 }}>
              <Title order={3} size="h5">
                Add a device
              </Title>
              <InfoButton title="Adding a device">
                <p>This device shows a code; the other one scans it (Sync → Scan code) or pastes it, and gets a full copy of this book.</p>
                <p>
                  The code works for one device, for ten minutes, on this network. A device that already holds something saves a copy of it
                  and then replaces it with this book, once you agree.
                </p>
              </InfoButton>
            </div>
            {code && qr ? (
              <>
                <Text size="sm" mb="sm">
                  {paired ? "Paired. The new device has a full copy." : "Waiting for the other device to scan this."}
                </Text>
                <div className="pairing-qr">
                  <img src={qr} alt="Pairing code" />
                </div>
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
              <Button size="xs" onClick={() => void showCode()}>
                Show pairing code
              </Button>
            )}
          </Paper>

          <Paper withBorder p="md" radius="md">
            <div className="with-info" style={{ marginBottom: 8 }}>
              <Title order={3} size="h5">
                Join another device's book
              </Title>
              <InfoButton title="Joining a book">
                <p>Scan the code another device shows (Sync → Add a device), or paste it. Both must be on the same network.</p>
                <p>
                  An empty device simply becomes a copy of that book. One that holds something asks first; then a complete copy of its
                  database is saved in the app's backups folder, and what's here is replaced by the book.
                </p>
              </InfoButton>
            </div>
            {joined ? (
              <Text size="sm">{joined}</Text>
            ) : pending ? (
              <Confirm
                text={`This device holds ${describeHeld(status.held)}. Joining replaces all of it with the other device's book; a complete copy of it is saved first.`}
                confirmLabel="Replace and join"
                onConfirm={() => void join(pending, true)}
                onCancel={() => setPending(null)}
              />
            ) : joining === "working" ? (
              <Group gap="sm">
                <Loader size="xs" />
                <Text size="sm">Copying everything over…</Text>
              </Group>
            ) : (
              <>
                {joining === "scanning" && android && <PhoneScanOverlay />}
                {joining === "scanning" && !android && (
                  <div className="pairing-camera-wrap">
                    <WebcamScanner onCode={takeCode} onError={scanFailed} />
                  </div>
                )}
                <Group gap="xs" mb="sm">
                  {joining === "scanning" && !android ? (
                    <Button size="xs" variant="default" onClick={() => setJoining("idle")}>
                      Stop scanning
                    </Button>
                  ) : (
                    <Button size="xs" onClick={() => void scan()}>
                      Scan code
                    </Button>
                  )}
                </Group>
                <Group gap="xs" wrap="nowrap" align="flex-end">
                  <TextInput
                    style={{ flex: 1 }}
                    aria-label="Pairing code"
                    placeholder="…or paste the code"
                    value={pasted}
                    onChange={(e) => setPasted(e.currentTarget.value)}
                  />
                  <Button size="sm" disabled={!pasted.trim().startsWith(PAIRING_PREFIX)} onClick={() => takeCode(pasted)}>
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
