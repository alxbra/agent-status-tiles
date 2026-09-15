import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';

const TEMPLATE_ICON_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48cGF0aCBmaWxsPSIjMDAwIiBkPSJNOCAxLjI1YTYuNzUgNi43NSAwIDEgMCAwIDEzLjVBNi43NSA2Ljc1IDAgMCAwIDggMS4yNVptMCAyLjFhNC42NSA0LjY1IDAgMSAxIDAgOS4zIDQuNjUgNC42NSAwIDAgMSAwLTkuM1ptMCAxLjVhMy4xNSAzLjE1IDAgMSAwIDAgNi4zIDMuMTUgMy4xNSAwIDAgMCAwLTYuM1oiLz48L3N2Zz4=';

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
  const icon = nativeImage.createFromDataURL(TEMPLATE_ICON_DATA_URL);
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
