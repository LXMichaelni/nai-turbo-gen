import {StrictMode, useEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

declare global {
  interface Window {
    __NAI_FAST_POLLER_REACT_READY_EMITTED__?: WeakSet<Element>;
    __NAI_FAST_POLLER_REACT_ROOTS__?: WeakMap<Element, Root>;
  }
}

const embeddedRootElement = document.getElementById('nai-fast-poller-react-host');
const standaloneRootElement = document.getElementById('root');
const rootElement = embeddedRootElement ?? standaloneRootElement;

if (!rootElement) {
  throw new Error('Missing React mount container (#root or #nai-fast-poller-react-host)');
}

const isEmbedded = rootElement === embeddedRootElement;
const reactRoots = window.__NAI_FAST_POLLER_REACT_ROOTS__ instanceof WeakMap
  ? window.__NAI_FAST_POLLER_REACT_ROOTS__
  : new WeakMap<Element, Root>();
const emittedReadyHosts = window.__NAI_FAST_POLLER_REACT_READY_EMITTED__ instanceof WeakSet
  ? window.__NAI_FAST_POLLER_REACT_READY_EMITTED__
  : new WeakSet<Element>();
window.__NAI_FAST_POLLER_REACT_ROOTS__ = reactRoots;
window.__NAI_FAST_POLLER_REACT_READY_EMITTED__ = emittedReadyHosts;
const root = reactRoots.get(rootElement) ?? createRoot(rootElement);
reactRoots.set(rootElement, root);

function EmbeddedReadySignal() {
  useEffect(() => {
    if (emittedReadyHosts.has(rootElement)) {
      return;
    }

    emittedReadyHosts.add(rootElement);
    window.dispatchEvent(new CustomEvent('nai-fast-poller:react-ready'));
  }, []);

  return null;
}

rootElement.classList.add('nai-fast-poller-app-root');

if (isEmbedded) {
  rootElement.classList.add('nai-fast-poller-embedded-host');
  document.body.classList.remove('nai-fast-poller-standalone');
} else {
  document.body.classList.add('nai-fast-poller-standalone');
}

root.render(
  <StrictMode>
    {isEmbedded ? <EmbeddedReadySignal /> : null}
    <App embedded={isEmbedded} />
  </StrictMode>,
);
