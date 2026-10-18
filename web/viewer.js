'use strict';
const token = location.hash.slice(1);
history.replaceState(null, '', '/');
const screen = document.querySelector('#screen');
const state = document.querySelector('#state');
const resume = document.querySelector('#resume');
const cancel = document.querySelector('#cancel');
const notice = document.querySelector('#notice');
let active = false, width = 1280, height = 800;
const ws = new WebSocket(`ws://${location.host}/operator`, ['operator-v1', token]);
function send(message) { if (active && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
ws.onmessage = event => {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'frame') { screen.src = 'data:image/jpeg;base64,' + message.data; width = message.width; height = message.height; screen.hidden = false; }
  if (message.type === 'status') {
    state.textContent = message.state;
    document.querySelector('#origin').textContent = (message.mode === 'fixture' ? 'Синтетическая проверка: ' : 'Текущий сайт: ') + (message.pageOrigin ?? 'не загружен');
    active = message.state === 'NEEDS_USER'; resume.disabled = cancel.disabled = !active;
    if (!active) { screen.hidden = true; screen.removeAttribute('src'); notice.textContent = message.state === 'READY' ? 'Интерфейс распознан. Можно закрыть это окно.' : 'Работа остановлена. Можно закрыть окно.'; }
  }
  if (message.type === 'notice') notice.textContent = ({ NOT_READY: 'Проверка ещё не завершена или состояние страницы не распознано.', INPUT_REJECTED: 'Действие отклонено.', STREAM_UNAVAILABLE: 'Трансляция недоступна.' })[message.code] ?? 'Ошибка прототипа.';
};
ws.onclose = () => { active = false; state.textContent = 'DISCONNECTED'; resume.disabled = cancel.disabled = true; screen.hidden = true; screen.removeAttribute('src'); };
ws.onerror = () => { notice.textContent = 'Нет доступа к локальной сессии. Старое окно нельзя переиспользовать после перезапуска.'; };
resume.onclick = () => send({ type: 'resume' });
cancel.onclick = () => send({ type: 'cancel' });
function pointer(event, kind) {
  const rect = screen.getBoundingClientRect();
  const x = Math.min(width - .001, Math.max(0, (event.clientX - rect.left) / rect.width * width));
  const y = Math.min(height - .001, Math.max(0, (event.clientY - rect.top) / rect.height * height));
  const button = kind === 'mouseWheel' ? 'none' : kind === 'mouseMoved' ? (event.buttons & 1 ? 'left' : event.buttons & 2 ? 'right' : event.buttons & 4 ? 'middle' : 'none') : ({0:'left',1:'middle',2:'right'})[event.button];
  send({ type: 'pointer', event: kind, x, y, button, buttons: event.buttons & 7, ...(kind === 'mouseWheel' ? { deltaX: Math.max(-4000, Math.min(4000, event.deltaX)), deltaY: Math.max(-4000, Math.min(4000, event.deltaY)) } : {}) });
}
screen.onpointerdown = event => { event.preventDefault(); screen.focus({ preventScroll: true }); screen.setPointerCapture(event.pointerId); pointer(event, 'mousePressed'); };
screen.onpointerup = event => { event.preventDefault(); pointer(event, 'mouseReleased'); };
screen.onpointermove = event => pointer(event, 'mouseMoved');
screen.onwheel = event => { event.preventDefault(); pointer(event, 'mouseWheel'); };
screen.oncontextmenu = event => event.preventDefault();
const codes = { Enter:13, Tab:9, Backspace:8, Delete:46, Escape:27, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Home:36, End:35, PageUp:33, PageDown:34, Space:32, ShiftLeft:16, ShiftRight:16, ControlLeft:17, ControlRight:17, AltLeft:18, AltRight:18, MetaLeft:91, MetaRight:92 };
function key(event, type) {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && ['v','c','x'].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  const modifiers = (event.altKey ? 1:0) | (event.ctrlKey ? 2:0) | (event.metaKey ? 4:0) | (event.shiftKey ? 8:0);
  const virtualKey = codes[event.code] ?? (/^Key[A-Z]$/.test(event.code) ? event.code.charCodeAt(3) : /^Digit[0-9]$/.test(event.code) ? event.code.charCodeAt(5) : 0);
  send({ type: 'key', event: type, key: event.key, code: event.code, modifiers, virtualKey, text: type === 'keyDown' && event.key.length === 1 && !(modifiers & 7) ? event.key : '' });
}
screen.onkeydown = event => key(event, 'keyDown');
screen.onkeyup = event => key(event, 'keyUp');
screen.onpaste = event => { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0,2048) }); };
screen.oncompositionend = event => { if (event.data) send({ type: 'text', text: event.data.slice(0,2048) }); };
