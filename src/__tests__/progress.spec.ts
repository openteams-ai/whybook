import type { KernelMessage } from '@jupyterlab/services';

import { RunProgress, tqdmText } from '../model/progress';

function message(
  type: string,
  content: Record<string, unknown>
): KernelMessage.IIOPubMessage {
  return { header: { msg_type: type }, content } as any;
}

function open(id: string, state: Record<string, unknown>) {
  return message('comm_open', { comm_id: id, data: { state } });
}

function update(id: string, state: Record<string, unknown>) {
  return message('comm_msg', {
    comm_id: id,
    data: { method: 'update', state }
  });
}

describe('tqdmText', () => {
  it('reads the last bar that tqdm drew', () => {
    const text =
      '\rbootstrap:   0%|          | 0/40 [00:00<?, ?it/s]' +
      '\rbootstrap:  40%|████      | 16/40 [00:01<00:01, 19.5it/s]';
    expect(tqdmText(text)).toEqual({ fraction: 0.4, stage: 'bootstrap' });
  });

  it('reads a bar without a description, and a description with colons', () => {
    expect(tqdmText(' 75%|███████▌  | 3/4 [00:03<00:01]')).toEqual({
      fraction: 0.75,
      stage: null
    });
    expect(tqdmText('fold 2: fit: 100%|██████████| 5/5 [00:02<00:00]')).toEqual(
      {
        fraction: 1,
        stage: 'fold 2: fit'
      }
    );
  });

  it('ignores other text', () => {
    expect(tqdmText('Loaded 40 rows\n')).toBeNull();
    expect(tqdmText('16it [00:01, 15.2it/s]')).toBeNull();
  });
});

describe('RunProgress', () => {
  it('follows the widget that tqdm.auto shows', () => {
    const progress = new RunProgress();
    expect(
      progress.read(
        open('bar', { _model_name: 'FloatProgressModel', min: 0, max: 40 })
      )
    ).toEqual({ fraction: 0, stage: null });
    // Other widgets of the bar: its two labels and the box around it.
    expect(
      progress.read(open('label', { _model_name: 'HTMLModel', value: '' }))
    ).toBeNull();
    expect(
      progress.read(
        message('display_data', {
          data: {
            'text/plain': 'bootstrap:   0%|          | 0/40 [00:00<?, ?it/s]',
            'application/vnd.jupyter.widget-view+json': { model_id: 'box' }
          }
        })
      )
    ).toEqual({ fraction: 0, stage: 'bootstrap' });
    expect(progress.read(update('bar', { value: 10 }))).toEqual({
      fraction: 0.25,
      stage: 'bootstrap'
    });
    expect(progress.read(update('label', { value: 'x' }))).toBeNull();
  });

  it('reports the outer bar of nested bars, and the running one of bars in turn', () => {
    const progress = new RunProgress();
    progress.read(open('outer', { _model_name: 'IntProgressModel', max: 4 }));
    progress.read(
      open('inner', { _model_name: 'FloatProgressModel', max: 10 })
    );
    expect(progress.read(update('inner', { value: 5 }))).toEqual({
      fraction: 0,
      stage: null
    });
    progress.read(update('outer', { value: 4 }));
    // The outer bar is full: the inner one is the one that runs now.
    expect(progress.read(update('inner', { value: 8 }))?.fraction).toBe(0.8);
  });

  it('reads tqdm text on stderr until a widget bar opens', () => {
    const progress = new RunProgress();
    const stderr = message('stream', {
      name: 'stderr',
      text: '\rfit:  50%|█████     | 1/2 [00:01<00:01]'
    });
    expect(progress.read(stderr)).toEqual({ fraction: 0.5, stage: 'fit' });
    expect(
      progress.read(
        message('stream', { name: 'stdout', text: '50%|█████     | 1/2' })
      )
    ).toBeNull();
    progress.read(open('bar', { _model_name: 'FloatProgressModel', max: 2 }));
    expect(progress.read(stderr)).toBeNull();
  });
});
