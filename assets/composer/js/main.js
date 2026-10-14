// @ts-check
/**
 * Entry point of the Open Space Composer: loads the block catalog and starts the application.
 */

import { Catalog } from './model/catalog.js';
import { App } from './view/app.js';

async function start() {
  const root = document.getElementById('composer');
  if (!root) return;
  const catalogUrl = root.dataset.catalog ?? '';
  const examplesUrl = root.dataset.examples ?? '';
  const formatUrl = root.dataset.format ?? '';
  /** @type {any[]} */
  let projects = [];
  try {
    projects = JSON.parse(document.getElementById('cmp-projects')?.textContent ?? '[]');
  } catch {
    projects = [];
  }
  try {
    const res = await fetch(catalogUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = new Catalog(await res.json());
    const app = new App(root, catalog, { examplesUrl, formatUrl, projects });
    // exposed for automated tests and the browser console
    Object.defineProperty(window, 'composer', { value: app, configurable: true });
  } catch (e) {
    const msg = document.createElement('p');
    msg.className = 'cmp-message cmp-error';
    msg.setAttribute('role', 'alert');
    msg.textContent = `The block catalog could not be loaded (${e instanceof Error ? e.message : String(e)}). Reload the page to try again.`;
    root.replaceChildren(msg);
  }
}

start();
