import {
  MIRROR_KEYS,
  type MirrorClientMessage,
  type MirrorKey,
} from '../shared/mobileRemote/mirrorMessages';
import type { PhoneConnectionStatus, RelayClient } from './relayClient';

const STATUS_COPY: Record<PhoneConnectionStatus, string> = {
  connecting: 'Connecting…',
  authenticating: 'Securing connection…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  update_required: 'Update required',
  authentication_failed: 'Pairing failed',
  connection_error: 'Connection error',
  closed: 'Disconnected',
};

type PointerState = {
  x: number;
  y: number;
  startX: number;
  startY: number;
};

export function renderMissingPairing(root: HTMLElement): void {
  root.innerHTML =
    '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Scan the pairing QR code in CCSM to connect.</p></main>';
}

export function createPhonePage(root: HTMLElement, client: RelayClient): () => void {
  root.innerHTML = `
    <div class="phone-shell">
      <header>
        <strong>CCSM Mobile Remote</strong>
        <span id="status" data-remote-status>Connecting…</span>
        <button id="fit" type="button" data-control disabled>Fit</button>
      </header>
      <main id="mirror-viewport" aria-label="CCSM desktop mirror">
        <img id="mirror-frame" alt="Live CCSM desktop" draggable="false" />
        <div id="empty-frame">Waiting for desktop…</div>
      </main>
      <section class="controls" aria-label="Remote controls">
        <form id="text-form">
          <input id="text-input" type="text" autocomplete="off" placeholder="Type text" disabled />
          <button id="input-send" type="submit" data-control disabled>Input</button>
        </form>
        <nav id="keybar" aria-label="Keys"></nav>
        <nav id="scrollbar" aria-label="Scroll">
          <button type="button" data-control data-scroll="-360" disabled>Scroll ↑</button>
          <button type="button" data-control data-scroll="360" disabled>Scroll ↓</button>
        </nav>
      </section>
    </div>`;

  const statusElement = root.querySelector<HTMLElement>('#status')!;
  const viewport = root.querySelector<HTMLElement>('#mirror-viewport')!;
  const frame = root.querySelector<HTMLImageElement>('#mirror-frame')!;
  const emptyFrame = root.querySelector<HTMLElement>('#empty-frame')!;
  const fitButton = root.querySelector<HTMLButtonElement>('#fit')!;
  const textForm = root.querySelector<HTMLFormElement>('#text-form')!;
  const textInput = root.querySelector<HTMLInputElement>('#text-input')!;
  const keybar = root.querySelector<HTMLElement>('#keybar')!;
  const pointers = new Map<number, PointerState>();
  let connected = false;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let pinchDistance = 0;
  let pinchScale = 1;

  function send(message: MirrorClientMessage): void {
    if (!connected) return;
    void client.send(message).catch(() => undefined);
  }

  function setControlsEnabled(enabled: boolean): void {
    connected = enabled;
    textInput.disabled = !enabled;
    for (const control of root.querySelectorAll<HTMLButtonElement>('[data-control]')) {
      control.disabled = !enabled;
    }
  }

  function applyTransform(): void {
    frame.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  function fit(): void {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    applyTransform();
  }

  function renderKeybar(): void {
    for (const key of MIRROR_KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.control = '';
      button.dataset.key = key;
      button.disabled = true;
      button.textContent = key
        .replace('ArrowUp', '↑')
        .replace('ArrowDown', '↓')
        .replace('ArrowLeft', '←')
        .replace('ArrowRight', '→');
      button.addEventListener('click', () => {
        send({ type: 'mirror.key', key: key as MirrorKey });
      });
      keybar.append(button);
    }
  }

  function pointerDistance(): number {
    const points = [...pointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
  }

  function handlePointerDown(event: PointerEvent): void {
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    viewport.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      pinchDistance = pointerDistance();
      pinchScale = scale;
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    const previousX = point.x;
    const previousY = point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size === 1) {
      offsetX += point.x - previousX;
      offsetY += point.y - previousY;
    } else if (pointers.size === 2 && pinchDistance > 0) {
      scale = Math.max(1, Math.min(4, pinchScale * (pointerDistance() / pinchDistance)));
    }
    applyTransform();
  }

  function handlePointerUp(event: PointerEvent): void {
    const point = pointers.get(event.pointerId);
    if (point && pointers.size === 1) {
      const moved = Math.hypot(point.x - point.startX, point.y - point.startY);
      const bounds = frame.getBoundingClientRect();
      if (moved < 8 && bounds.width > 0 && bounds.height > 0) {
        send({
          type: 'mirror.tap',
          x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
          y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
        });
      }
    }
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
  }

  renderKeybar();
  fitButton.addEventListener('click', fit);
  textForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!connected || textInput.value.length === 0) return;
    send({ type: 'mirror.text', text: textInput.value });
    textInput.value = '';
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-scroll]')) {
    button.addEventListener('click', () => {
      send({ type: 'mirror.scroll', deltaY: Number(button.dataset.scroll) });
    });
  }
  viewport.addEventListener('pointerdown', handlePointerDown);
  viewport.addEventListener('pointermove', handlePointerMove);
  viewport.addEventListener('pointerup', handlePointerUp);
  viewport.addEventListener('pointercancel', handlePointerUp);

  const removeMessageHandler = client.onMessage((message) => {
    if (message.type === 'mirror.error') {
      statusElement.textContent = message.message.replaceAll('_', ' ');
      return;
    }
    frame.src = `data:image/jpeg;base64,${message.jpegBase64}`;
    frame.width = message.width;
    frame.height = message.height;
    emptyFrame.hidden = true;
  });
  const removeStatusHandler = client.onStatus((status) => {
    statusElement.textContent = STATUS_COPY[status];
    statusElement.dataset.status = status;
    setControlsEnabled(status === 'connected');
    if (status === 'connected') send({ type: 'mirror.start' });
  });

  return () => {
    removeMessageHandler();
    removeStatusHandler();
    fitButton.removeEventListener('click', fit);
    viewport.removeEventListener('pointerdown', handlePointerDown);
    viewport.removeEventListener('pointermove', handlePointerMove);
    viewport.removeEventListener('pointerup', handlePointerUp);
    viewport.removeEventListener('pointercancel', handlePointerUp);
  };
}
