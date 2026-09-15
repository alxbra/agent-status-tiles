import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';

const TEMPLATE_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAAAi0lEQVQ4Ec1TyQ2AIBAEH1ob3WkLtgZvW8AdIhtdWVH04SQbCHNwG/MResoZqRaqWClooIWHMVGvZpQ8Qhh3ZpYB8DCYdM5F732UwBg4cuzrHFAy5zBwMsBuESASSJy7xdbabEm07YqqB4M/DAghqBu44vh0W6+x+SHlQ5zVdevEwTOQ7tVn0uepMCt0VLBsQ8ZHTwAAAABJRU5ErkJggg==';

export interface MenuBarActions {
  showOverlay(): void;
  hideOverlay(): void;
  openSettings(): void;
  quit(): void;
}

export interface MenuBarController {
  getTray(): Tray;
  destroy(): void;
}

function createTemplateIcon() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TEMPLATE_ICON_PNG_BASE64, 'base64'));
  if (icon.isEmpty()) {
    throw new Error('Unable to create the menu-bar template icon');
  }
  icon.setTemplateImage(true);
  return icon;
}

export function createMenuBar(actions: MenuBarActions): MenuBarController {
  const tray = new Tray(createTemplateIcon());
  tray.setToolTip('Agent Status Tiles');

  const menuTemplate: MenuItemConstructorOptions[] = [
    { label: 'Show', click: actions.showOverlay },
    { label: 'Hide', click: actions.hideOverlay },
    { type: 'separator' },
    { label: 'Settings', click: actions.openSettings },
    { label: 'Quit', click: actions.quit },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));

  return {
    getTray: () => tray,
    destroy: () => tray.destroy(),
  };
}
