// Entry of the `shelf` bundle: the changes-tree dialogs Create Patch and Apply Patch.
import type { ShelfInit } from '../../features/stash/protocol';
import { init } from '../shared/rpc';
import { ensureStyles } from '../shared/ui';
import { startShelfDialog } from './dialog';

ensureStyles();
const data = init<ShelfInit>();
if (data.mode !== 'view') startShelfDialog(data);
