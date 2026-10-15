import React, { FormEventHandler, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, color, config, Input, Spinner, Text, toRem } from 'folds';
import QRCode from 'qrcode';
import {
  ClientRendezvousFailureReason,
  isSignInWithQRAvailable,
  linkNewDeviceByGeneratingQR,
  MSC4108FailureReason,
  MSC4108SignInWithQR,
  RendezvousError,
  RendezvousFailureReason,
} from 'matrix-js-sdk/lib/rendezvous';
import { SequenceCard } from '../../../components/sequence-card';
import { SettingTile } from '../../../components/setting-tile';
import { SequenceCardStyle } from '../styles.css';
import { useMatrixClient } from '../../../hooks/useMatrixClient';

// Sign in a new device (e.g. Element X) by scanning a QR code shown here, then
// hand it this device's encryption secrets. MSC4108, as in Element Web.
type Phase =
  | { name: 'Idle' }
  | { name: 'Loading' }
  | { name: 'ShowingQR'; qrDataUrl: string }
  | { name: 'CheckCode'; verificationUri?: string; mismatch?: boolean }
  | { name: 'WaitingForDevice' }
  | { name: 'Done' }
  | { name: 'Error'; message: string };

const failureMessage = (reason?: RendezvousFailureReason): string => {
  switch (reason) {
    case ClientRendezvousFailureReason.Expired:
    case MSC4108FailureReason.AuthorizationExpired:
      return 'The QR code expired. Try again.';
    case MSC4108FailureReason.UserCancelled:
      return 'The sign in was cancelled.';
    case ClientRendezvousFailureReason.UserDeclined:
      return 'The sign in was declined on the other device.';
    case MSC4108FailureReason.UnsupportedProtocol:
    case ClientRendezvousFailureReason.HomeserverLacksSupport:
      return 'Your homeserver does not support sign in with a QR code.';
    case MSC4108FailureReason.DeviceAlreadyExists:
      return 'That device is already signed in.';
    default:
      return 'Something went wrong. Try again.';
  }
};

const useLinkAvailable = (): boolean => {
  const mx = useMatrixClient();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const crypto = mx.getCrypto();
      if (!crypto?.exportSecretsBundle) return false;
      // The new device gets our cross-signing keys: we must hold them.
      const status = await crypto.getCrossSigningStatus();
      const keys = status.privateKeysCachedLocally;
      if (!keys.masterKey || !keys.selfSigningKey || !keys.userSigningKey) return false;
      return isSignInWithQRAvailable(mx);
    };
    check()
      .catch(() => false)
      .then((ok) => {
        if (alive) setAvailable(ok);
      });
    return () => {
      alive = false;
    };
  }, [mx]);

  return available;
};

export function LinkDevice() {
  const mx = useMatrixClient();
  const available = useLinkAvailable();
  const [phase, setPhase] = useState<Phase>({ name: 'Idle' });
  const flowRef = useRef<MSC4108SignInWithQR>();
  const abortRef = useRef<AbortController>();

  const fail = useCallback((reason?: RendezvousFailureReason) => {
    abortRef.current = undefined;
    setPhase({ name: 'Error', message: failureMessage(reason) });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    flowRef.current = undefined;
    setPhase({ name: 'Idle' });
  }, []);

  // Leaving the page cancels a flow still running.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase({ name: 'Loading' });

    let flow: MSC4108SignInWithQR;
    try {
      flow = await linkNewDeviceByGeneratingQR(mx, (reason) => fail(reason), abort.signal);
      if (abort.signal.aborted || !flow.code) return;
      flowRef.current = flow;
      const qrDataUrl = await QRCode.toDataURL(
        [{ data: new Uint8ClampedArray(flow.code), mode: 'byte' }],
        { errorCorrectionLevel: 'L', margin: 2, width: 240 }
      );
      setPhase({ name: 'ShowingQR', qrDataUrl });
    } catch {
      if (!abort.signal.aborted) fail(ClientRendezvousFailureReason.HomeserverLacksSupport);
      return;
    }

    try {
      // The new device scanned the code: it asks the server for a device grant.
      await flow.negotiateProtocols();
      const { verificationUri } = await flow.deviceAuthorizationGrant();
      if (abort.signal.aborted) return;
      setPhase({ name: 'CheckCode', verificationUri });
    } catch (e) {
      if (abort.signal.aborted) return;
      const reason = e instanceof RendezvousError ? e.code : undefined;
      await flow.cancel(reason ?? ClientRendezvousFailureReason.Unknown).catch(() => undefined);
      fail(reason);
    }
  }, [mx, fail]);

  const handleCheckCode: FormEventHandler<HTMLFormElement> = async (evt) => {
    evt.preventDefault();
    const flow = flowRef.current;
    if (!flow || phase.name !== 'CheckCode') return;
    const { codeInput } = evt.target as HTMLFormElement & { codeInput: HTMLInputElement };

    if (flow.checkCode !== codeInput.value.trim()) {
      setPhase({ ...phase, mismatch: true });
      return;
    }

    // The account page approves the new device; we then send it our secrets.
    if (phase.verificationUri) window.open(phase.verificationUri, '_blank');
    setPhase({ name: 'WaitingForDevice' });
    try {
      await flow.shareSecrets();
      abortRef.current = undefined;
      setPhase({ name: 'Done' });
    } catch (e) {
      if (abortRef.current?.signal.aborted) return;
      fail(e instanceof RendezvousError ? e.code : undefined);
    }
  };

  if (!available) return null;

  return (
    <Box direction="Column" gap="100">
      <Text size="L400">Link new device</Text>
      <SequenceCard
        className={SequenceCardStyle}
        variant="SurfaceVariant"
        direction="Column"
        gap="400"
      >
        <SettingTile
          title="Sign in with QR code"
          description="Sign in on your phone by scanning a QR code in its Matrix app (e.g. Element X). Your encrypted messages come along."
          after={
            (phase.name === 'Idle' || phase.name === 'Done' || phase.name === 'Error') && (
              <Button size="300" variant="Secondary" fill="Soft" radii="300" onClick={start}>
                <Text size="B300">Show QR code</Text>
              </Button>
            )
          }
        />

        {phase.name === 'Loading' && (
          <Box justifyContent="Center">
            <Spinner variant="Secondary" />
          </Box>
        )}

        {phase.name === 'ShowingQR' && (
          <Box direction="Column" alignItems="Center" gap="300">
            <img
              src={phase.qrDataUrl}
              alt="QR code to sign in a new device"
              style={{ width: toRem(240), height: toRem(240), borderRadius: config.radii.R300 }}
            />
            <Text size="T200" priority="300" align="Center">
              In the app on your phone, choose &quot;Sign in with QR code&quot; and scan this code.
            </Text>
            <Button size="300" variant="Secondary" fill="None" radii="300" onClick={stop}>
              <Text size="B300">Cancel</Text>
            </Button>
          </Box>
        )}

        {phase.name === 'CheckCode' && (
          <Box as="form" onSubmit={handleCheckCode} direction="Column" gap="200">
            <Text size="T300">Enter the 2-digit code shown on your phone.</Text>
            <Box gap="200">
              <Input
                name="codeInput"
                inputMode="numeric"
                autoComplete="off"
                maxLength={2}
                size="400"
                variant="Background"
                radii="300"
                outlined
                autoFocus
                required
                style={{ width: toRem(80) }}
              />
              <Button type="submit" size="400" variant="Primary" radii="300">
                <Text size="B400">Continue</Text>
              </Button>
              <Button size="400" variant="Secondary" fill="None" radii="300" onClick={stop}>
                <Text size="B400">Cancel</Text>
              </Button>
            </Box>
            {phase.mismatch && (
              <Text size="T200" style={{ color: color.Critical.Main }}>
                The code does not match. Check the code on your phone.
              </Text>
            )}
            <Text size="T200" priority="300">
              A page then opens to approve the new device.
            </Text>
          </Box>
        )}

        {phase.name === 'WaitingForDevice' && (
          <Box alignItems="Center" gap="200">
            <Spinner size="200" variant="Secondary" />
            <Text size="T300">Approve the device on the page that opened, then wait a moment.</Text>
          </Box>
        )}

        {phase.name === 'Done' && (
          <Text size="T300" style={{ color: color.Success.Main }}>
            Your new device is signed in.
          </Text>
        )}

        {phase.name === 'Error' && (
          <Text size="T300" style={{ color: color.Critical.Main }}>
            {phase.message}
          </Text>
        )}
      </SequenceCard>
    </Box>
  );
}
