/**
 * Local models that the analyst adds in the settings: customLocalModels in
 * schema/plugin.json. The server gets them with each status request, and a
 * request for one carries its spec: whybook/server/local_models.py,
 * register_custom and model_of.
 */
export interface ICustomLocalModel {
  /** The name in the selects of the settings. */
  name: string;
  /** A Hugging Face repository, such as ggml-org/gemma-4-E2B-it-GGUF. */
  repo?: string;
  /** The GGUF file in the repository. */
  file?: string;
  /** A commit or a branch of the repository; the latest file when left out. */
  revision?: string;
  /** The SHA-256 of the file: a download whose file differs is deleted. */
  sha256?: string;
  /** The absolute path of a GGUF file on the server's machine, in place of a repository. */
  path?: string;
  /** What the choice means, under the select. */
  note?: string;
}

/** The models of the settings that have a name, as the settings store them. */
export function readCustomModels(value: unknown): ICustomLocalModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is ICustomLocalModel =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as ICustomLocalModel).name === 'string' &&
      (item as ICustomLocalModel).name.trim() !== ''
  );
}

/** The id of a name: local_models.custom_id computes the same. */
export function customId(name: string): string {
  const slug = name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `custom:${slug || 'model'}`;
}

/** The id of each model, with the next free number for a name that repeats, as the server numbers them. */
export function customIds(models: ICustomLocalModel[]): string[] {
  const taken = new Set<string>();
  return models.map(model => {
    const base = customId(model.name);
    let id = base;
    for (let number = 2; taken.has(id); number++) {
      id = `${base}-${number}`;
    }
    taken.add(id);
    return id;
  });
}

/** The spec of the model of the settings with this id, if there is one. */
export function customSpec(
  models: ICustomLocalModel[],
  id: string
): ICustomLocalModel | undefined {
  if (!id.startsWith('custom:')) {
    return undefined;
  }
  const ids = customIds(models);
  return models[ids.indexOf(id)];
}
