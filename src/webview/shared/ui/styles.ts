// Injects the kit stylesheets (base tokens/controls + components) once per page.
import base from '../base.css';
import kit from './kit.css';

let injected = false;

export function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'jb-ui-kit';
  style.textContent = base + '\n' + kit;
  document.head.prepend(style);
  // allow :hover/:focus-visible styling that depends on keyboard vs mouse
  document.documentElement.classList.add('jb-ui');
}
