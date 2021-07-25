import * as E from "fp-ts/Either";
import * as M from "fp-ts/Map";
import * as O from "fp-ts/Option";
import * as TE from "fp-ts/TaskEither";
import { constVoid, pipe } from "fp-ts/function";
import * as Str from "fp-ts/string";
import * as D from "io-ts/Decoder";
import { Lens } from "monocle-ts";
import { match } from "ts-pattern";

import { isFalse } from "./typeGuards";

/*
 * Types
 */

enum ExtensionConfigKeys {
  FormatterPath = "hansjhoffman.nix.config.nixFormatPath",
  FormatOnSave = "hansjhoffman.nix.config.formatOnSave",
  FormatDocument = "hansjhoffman.nix.commands.formatDocument",
}

interface ExtensionSettings {
  workspace: {
    formatterPath: O.Option<string>;
    formatOnSave: boolean;
  };
  global: {
    formatterPath: O.Option<string>;
    formatOnSave: boolean;
  };
}

interface InvokeFormatterError {
  _tag: "invokeFormatterError";
  reason: string;
}

/*
 * Helpers
 */

const showNotification = (body: string): void => {
  if (nova.inDevMode()) {
    const notification = new NotificationRequest("nix-nova-notification");
    notification.title = nova.extension.name;
    notification.body = body;
    nova.notifications.add(notification);
  }
};

const safeFormat = (
  editor: TextEditor,
  formatterPath: string,
): TE.TaskEither<InvokeFormatterError, void> => {
  const documentPath = editor.document.path;

  return TE.tryCatch<InvokeFormatterError, void>(
    () => {
      return new Promise<void>((resolve, reject) => {
        const process = new Process("/usr/bin/env", {
          args: [`${formatterPath}`, `${documentPath}`],
        });

        process.onDidExit((status) => (status === 0 ? resolve() : reject()));

        process.start();
      });
    },
    () => ({
      _tag: "invokeFormatterError",
      reason: `${nova.localize("Failed to format the document")}.`,
    }),
  );
};

/*
 * Main
 */

let configs: ExtensionSettings = {
  workspace: {
    formatOnSave: pipe(
      O.fromNullable(nova.workspace.config.get(ExtensionConfigKeys.FormatOnSave)),
      O.chain((value) => O.fromEither(D.boolean.decode(value))),
      O.getOrElseW(() => false),
    ),
    formatterPath: pipe(
      O.fromNullable(nova.workspace.config.get(ExtensionConfigKeys.FormatterPath)),
      O.chain((path) => O.fromEither(D.string.decode(path))),
      O.chain(O.fromPredicate((path) => isFalse(Str.isEmpty(path)))),
    ),
  },
  global: {
    formatOnSave: pipe(
      O.fromNullable(nova.config.get(ExtensionConfigKeys.FormatOnSave)),
      O.chain((value) => O.fromEither(D.boolean.decode(value))),
      O.getOrElseW(() => false),
    ),
    formatterPath: pipe(
      O.fromNullable(nova.config.get(ExtensionConfigKeys.FormatterPath)),
      O.chain((path) => O.fromEither(D.string.decode(path))),
      O.chain(O.fromPredicate((path) => isFalse(Str.isEmpty(path)))),
    ),
  },
};

const workspaceConfigsLens = Lens.fromPath<ExtensionSettings>()(["workspace"]);
const globalConfigsLens = Lens.fromPath<ExtensionSettings>()(["global"]);

const compositeDisposable: CompositeDisposable = new CompositeDisposable();
let saveListeners: Map<string, Disposable> = new Map();

/**
 * Gets a value giving precedence to workspace over global extension values.
 * @param {ExtensionSettings} configs - extension settings
 */
const selectFormatOnSave = (configs: ExtensionSettings): boolean => {
  const workspace = workspaceConfigsLens.get(configs);
  const global = globalConfigsLens.get(configs);

  return workspace.formatOnSave || global.formatOnSave;
};

/**
 * Gets a value giving precedence to workspace over global extension values.
 * @param {ExtensionSettings} configs - extension settings
 */
const selectFormatterPath = (configs: ExtensionSettings): O.Option<string> => {
  const workspace = workspaceConfigsLens.get(configs);
  const global = globalConfigsLens.get(configs);

  return pipe(
    workspace.formatterPath,
    O.alt(() => global.formatterPath),
  );
};

const addSaveListener = (editor: TextEditor): void => {
  pipe(
    O.fromNullable(editor.document.syntax),
    O.chain(O.fromPredicate((syntax) => Str.Eq.equals(syntax, "nix"))),
    O.fold(constVoid, (_) => {
      saveListeners = M.upsertAt(Str.Eq)(editor.document.uri, editor.onWillSave(formatDocument))(
        saveListeners,
      );
    }),
  );
};

const clearSaveListeners = (): void => {
  pipe(
    saveListeners,
    M.map((disposable) => disposable.dispose()),
  );

  saveListeners = new Map();
};

const formatDocument = (editor: TextEditor): void => {
  pipe(
    selectFormatterPath(configs),
    O.fold(
      () => console.log(`${nova.localize("Skipping")}... ${nova.localize("No formatter set")}.`),
      (path) => {
        safeFormat(editor, path)().then(
          E.fold(
            (err) => {
              return match(err)
                .with({ _tag: "invokeFormatterError" }, ({ reason }) => console.error(reason))
                .exhaustive();
            },
            () => console.log(`${nova.localize("Formatted")} ${editor.document.path}`),
          ),
        );
      },
    ),
  );
};

export const activate = (): void => {
  console.log(`${nova.localize("Activating")}...`);
  showNotification(`${nova.localize("Starting extension")}...`);

  compositeDisposable.add(
    nova.workspace.onDidAddTextEditor((editor: TextEditor): void => {
      const shouldFormatOnSave = selectFormatOnSave(configs);

      if (shouldFormatOnSave) {
        addSaveListener(editor);
      }
    }),
  );

  compositeDisposable.add(
    nova.commands.register(ExtensionConfigKeys.FormatDocument, formatDocument),
  );

  compositeDisposable.add(
    nova.workspace.config.onDidChange<unknown>(
      ExtensionConfigKeys.FormatterPath,
      (newValue, _oldValue): void => {
        configs = workspaceConfigsLens.modify((prevWorkspace) => ({
          ...prevWorkspace,
          formatterPath: O.fromEither(D.string.decode(newValue)),
        }))(configs);

        const shouldFormatOnSave = selectFormatOnSave(configs);

        if (shouldFormatOnSave) {
          clearSaveListeners();
          nova.workspace.textEditors.forEach(addSaveListener);
        }
      },
    ),
  );

  compositeDisposable.add(
    nova.workspace.config.onDidChange<unknown>(
      ExtensionConfigKeys.FormatOnSave,
      (newValue, _oldValue): void => {
        configs = workspaceConfigsLens.modify((prevWorkspace) => ({
          ...prevWorkspace,
          formatOnSave: pipe(
            D.boolean.decode(newValue),
            E.getOrElseW(() => false),
          ),
        }))(configs);

        const shouldFormatOnSave = selectFormatOnSave(configs);

        clearSaveListeners();

        if (shouldFormatOnSave) {
          nova.workspace.textEditors.forEach(addSaveListener);
        }
      },
    ),
  );

  compositeDisposable.add(
    nova.config.onDidChange<unknown>(
      ExtensionConfigKeys.FormatterPath,
      (newValue, _oldValue): void => {
        configs = globalConfigsLens.modify((prevGlobal) => ({
          ...prevGlobal,
          formatterPath: O.fromEither(D.string.decode(newValue)),
        }))(configs);

        const shouldFormatOnSave = selectFormatOnSave(configs);

        if (shouldFormatOnSave) {
          clearSaveListeners();
          nova.workspace.textEditors.forEach(addSaveListener);
        }
      },
    ),
  );

  compositeDisposable.add(
    nova.config.onDidChange<unknown>(
      ExtensionConfigKeys.FormatOnSave,
      (newValue, _oldValue): void => {
        configs = globalConfigsLens.modify((prevGlobal) => ({
          ...prevGlobal,
          formatOnSave: pipe(
            D.boolean.decode(newValue),
            E.getOrElseW(() => false),
          ),
        }))(configs);

        const shouldFormatOnSave = selectFormatOnSave(configs);

        clearSaveListeners();

        if (shouldFormatOnSave) {
          nova.workspace.textEditors.forEach(addSaveListener);
        }
      },
    ),
  );

  console.log(`${nova.localize("Activated")} 🎉`);
};

export const deactivate = (): void => {
  console.log(`${nova.localize("Deactivating")}...`);

  clearSaveListeners();
  compositeDisposable.dispose();
};
