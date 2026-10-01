import { LabIcon } from '@jupyterlab/ui-components';

/**
 * The icons of the Whybook. The view's own icon is an orange tile, in
 * the colour of JupyterLab's notebook icon, with a cell prompt that holds a
 * question: `[?]`. The side panel icons are filled 24 px glyphs in the grey
 * of JupyterLab's own side panel icons. The sources and the candidates they
 * were chosen from are in design/icons/.
 */

export const epiIcon = new LabIcon({
  name: 'whybook:epinotebook',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 22 22"><rect x="1.5" y="1.5" width="19" height="19" rx="4.2" fill="#F37626" class="jp-notebook-icon-color"/><g fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.7 5.7H5.2v10.6h1.5M15.3 5.7h1.5v10.6h-1.5"/><path d="M9 8.7a2.1 2.1 0 1 1 3.1 1.8c-.7.4-1.1.9-1.1 1.7v.2"/></g><circle cx="11" cy="15" r="1.1" fill="#fff"/></svg>'
});

/**
 * The view's `[?]` without its tile, in the grey of the status bar's icons:
 * the status bar item that counts the agents' runs that go on.
 */
export const agentRunIcon = new LabIcon({
  name: 'whybook:agent-run',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 22 22" fill="none"><g stroke="#616161" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="jp-icon3"><path d="M6.7 4.7H4.2v12.6h2.5M15.3 4.7h2.5v12.6h-2.5"/><path d="M8.9 8.4a2.1 2.1 0 1 1 3.1 1.8c-.7.4-1.1.9-1.1 1.7v.3"/></g><circle cx="10.9" cy="15" r="1.15" fill="#616161" class="jp-icon3"/></svg>'
});

export const variablesIcon = new LabIcon({
  name: 'whybook:variables',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><g fill="none" stroke="#616161" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" class="jp-icon3"><path d="M9 4h-.9C6.8 4 6 4.8 6 6.1v3.3c0 1.2-.8 2.1-2 2.6 1.2.5 2 1.4 2 2.6v3.3C6 19.2 6.8 20 8.1 20H9"/><path d="M15 4h.9C17.2 4 18 4.8 18 6.1v3.3c0 1.2.8 2.1 2 2.6-1.2.5-2 1.4-2 2.6v3.3c0 1.3-.8 2.1-2.1 2.1H15"/></g><circle cx="12" cy="12" r="2.3" fill="#616161" class="jp-icon3"/></svg>'
});

export const databaseIcon = new LabIcon({
  name: 'whybook:database',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><g fill="#616161" class="jp-icon3"><ellipse cx="12" cy="5.6" rx="8" ry="3.1"/><path d="M4 8.4v3.7c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1V8.4c-1.6 1.3-4.6 2.1-8 2.1s-6.4-.8-8-2.1z"/><path d="M4 14.6v3.8c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1v-3.8c-1.6 1.3-4.6 2.1-8 2.1s-6.4-.8-8-2.1z"/></g></svg>'
});

export const explorationIcon = new LabIcon({
  name: 'whybook:exploration',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24"><path fill="#616161" fill-rule="evenodd" class="jp-icon3" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm4.6 5.4-6.5 2.7-2.7 6.5 6.5-2.7zM12 10.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z"/></svg>'
});

/**
 * "mic_none" of Google's Material Icons (Apache 2.0), for asking a question
 * by voice: a microphone drawn in outline, as light as the help icon below.
 */
export const microphoneIcon = new LabIcon({
  name: 'whybook:microphone',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="#616161" class="jp-icon3" d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1.2-9.1c0-.66.54-1.2 1.2-1.2.66 0 1.2.54 1.2 1.2l-.01 6.2c0 .66-.53 1.2-1.19 1.2-.66 0-1.2-.54-1.2-1.2V4.9zm6.5 6.1c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>'
});

/**
 * "help_outline" of Google's Material Icons (Apache 2.0), for the help of a
 * setting: a question mark in a ring that keeps 2 of its 24 units clear of
 * each edge, so that no size cuts it.
 */
export const helpIcon = new LabIcon({
  name: 'whybook:help',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="#616161" class="jp-icon3" d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>'
});

/**
 * The icon of the Check-up, a stethoscope drawn in outline in the grey of
 * JupyterLab's own icons (design iteration 1.68). The head of the Check-up
 * shows it beside the name, and a notebook's tab fades into it while the
 * pointer is on the tab (../style/checkup.css), so that the two read as one
 * place. It is `checkup-b-stethoscope.svg` of design/icons/, one of five
 * candidates there.
 */
export const checkupIcon = new LabIcon({
  name: 'whybook:checkup',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24" fill="none"><g stroke="#616161" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="jp-icon3"><path d="M5.5 2.5h-1a2 2 0 0 0-2 2V8a5 5 0 0 0 10 0V4.5a2 2 0 0 0-2-2h-1M7.5 13v2a5.75 5.75 0 0 0 11.5 0v-1.8"/><circle cx="19" cy="10.2" r="3"/></g></svg>'
});
