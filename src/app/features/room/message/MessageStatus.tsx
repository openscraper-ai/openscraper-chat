import React, { useEffect, useId, useState } from 'react';
import { EventStatus, MatrixEvent, MatrixEventEvent, Room, RoomEvent } from 'matrix-js-sdk';
import { color, Icon, Icons, Text, Tooltip, TooltipProvider } from 'folds';
import * as css from './styles.css';

// WhatsApp-like ticks on our own messages: sending, sent, read by everyone.
// Matrix has no delivery receipt, so there is no "received" step between sent and read.
type MessageState =
  | { kind: 'failed' }
  | { kind: 'sending' }
  | { kind: 'sent'; readBy: number; members: number }
  | { kind: 'read' };

const getMessageState = (room: Room, mEvent: MatrixEvent, myUserId: string): MessageState => {
  if (mEvent.status === EventStatus.NOT_SENT) return { kind: 'failed' };
  const eventId = mEvent.getId();
  if (mEvent.status || !eventId?.startsWith('$')) return { kind: 'sending' };

  const others = room.getJoinedMembers().filter((m) => m.userId !== myUserId);
  if (others.length === 0) return { kind: 'sent', readBy: 0, members: 0 };
  const readBy = others.filter((m) => room.hasUserReadEvent(m.userId, eventId)).length;
  if (readBy === others.length) return { kind: 'read' };
  return { kind: 'sent', readBy, members: others.length };
};

const useMessageState = (room: Room, mEvent: MatrixEvent, myUserId: string): MessageState => {
  const [state, setState] = useState(() => getMessageState(room, mEvent, myUserId));

  useEffect(() => {
    const update = () => setState(getMessageState(room, mEvent, myUserId));
    update();

    mEvent.on(MatrixEventEvent.Status, update);
    room.on(RoomEvent.Receipt, update);
    room.on(RoomEvent.LocalEchoUpdated, update);
    return () => {
      mEvent.removeListener(MatrixEventEvent.Status, update);
      room.removeListener(RoomEvent.Receipt, update);
      room.removeListener(RoomEvent.LocalEchoUpdated, update);
    };
  }, [room, mEvent, myUserId]);

  return state;
};

const stateLabel = (state: MessageState): string => {
  switch (state.kind) {
    case 'failed':
      return 'Not sent';
    case 'sending':
      return 'Sending';
    case 'read':
      return 'Read';
    default:
      return state.members > 1 && state.readBy > 0
        ? `Sent, read by ${state.readBy} of ${state.members}`
        : 'Sent';
  }
};

type MessageStatusProps = {
  room: Room;
  mEvent: MatrixEvent;
  myUserId: string;
};
export function MessageStatus({ room, mEvent, myUserId }: MessageStatusProps) {
  const state = useMessageState(room, mEvent, myUserId);
  const labelId = useId();

  let src = Icons.Check;
  let iconColor: string | undefined;
  if (state.kind === 'failed') {
    src = Icons.Warning;
    iconColor = color.Critical.Main;
  } else if (state.kind === 'sending') {
    src = Icons.RecentClock;
  } else if (state.kind === 'read') {
    src = Icons.CheckTwice;
    iconColor = color.Primary.Main;
  }

  return (
    <TooltipProvider
      position="Left"
      align="Center"
      offset={4}
      delay={300}
      tooltip={
        <Tooltip id={labelId}>
          <Text size="T200">{stateLabel(state)}</Text>
        </Tooltip>
      }
    >
      {(triggerRef) => (
        <span ref={triggerRef} aria-labelledby={labelId} className={css.MessageStatus}>
          <Icon
            size="50"
            src={src}
            style={{ color: iconColor, opacity: iconColor ? undefined : 0.6 }}
          />
        </span>
      )}
    </TooltipProvider>
  );
}
