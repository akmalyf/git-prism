// Entry of the `shelf` bundle: the Shelf view (mode 'view') or one of the changes-tree dialogs (Shelve Changes,
// Unshelve Changes, Create Patch, Apply Patch).
import type { ShelfInit } from '../../features/stash/protocol';
import { init } from '../shared/rpc';
import { ensureStyles } from '../shared/ui';
import { startShelfDialog } from './dialog';
import { startShelfView } from './view';

ensureStyles();
const data = init<ShelfInit>();
if (data.mode === 'view') startShelfView();
else startShelfDialog(data);
