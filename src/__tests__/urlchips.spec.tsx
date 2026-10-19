/**
 * The words of a URL in a chip (design iteration 1.143): what matters in the
 * URL, and not its scheme. A GitHub URL shows the GitHub mark, the owner, the
 * repository and the path, and the branch, tag or commit that it names, but
 * HEAD, which is the default branch. A record of Zenodo shows its number, as
 * its DOI ends, and the file. Any other URL shows its host and path. The file
 * name shows whole, and the tooltip and the popover give the URL in full.
 */
import './fakes/quiet';

import * as React from 'react';

import { decisionChips, urlView } from '../model/decisions';
import type { IDecision } from '../tokens';
import { DecisionChips } from '../ui/common';
import { mount } from './fakes/bench-render';

const THINKSTATS =
  'https://github.com/AllenDowney/ThinkStats2/raw/master/code/';

/** A call of download(url), as the first cell of ThinkStats2's chapter 3 makes six. */
function download(url: string, line: number): IDecision {
  return {
    name: 'url',
    value: `'${url}'`,
    provenance: 'you',
    param: 'url',
    function: 'download',
    calls: [{ line, col: 0, target: null }]
  };
}

describe('urlView', () => {
  it('shows a GitHub URL by its owner, repository and path, with the branch it names', () => {
    expect(urlView(`${THINKSTATS}thinkstats2.py`)).toEqual({
      site: 'github',
      text: 'AllenDowney/ThinkStats2/code/thinkstats2.py',
      ref: 'master'
    });
    expect(
      urlView(
        'https://raw.githubusercontent.com/owner/repo/refs/heads/dev/data/2019/visits.csv'
      )
    ).toEqual({
      site: 'github',
      text: 'owner/repo/data/2019/visits.csv',
      ref: 'dev'
    });
    // A commit by its first seven characters, and no query.
    expect(
      urlView(
        'https://github.com/owner/repo/blob/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b/data.csv?raw=true'
      )
    ).toEqual({ site: 'github', text: 'owner/repo/data.csv', ref: '1a2b3c4' });
    // The asset of a release, by its tag.
    expect(
      urlView(
        'https://github.com/owner/repo/releases/download/v1.2.0/model.pkl'
      )
    ).toEqual({ site: 'github', text: 'owner/repo/model.pkl', ref: 'v1.2.0' });
    expect(urlView('https://github.com/owner/repo')).toEqual({
      site: 'github',
      text: 'owner/repo',
      ref: null
    });
  });

  it('leaves out HEAD, which names the default branch', () => {
    expect(
      urlView(
        'https://raw.githubusercontent.com/owner/repo/HEAD/data/visits_2019.csv'
      )
    ).toEqual({
      site: 'github',
      text: 'owner/repo/data/visits_2019.csv',
      ref: null
    });
  });

  it('shows a record of Zenodo by its number, as its DOI ends, and the file', () => {
    expect(
      urlView(
        'https://zenodo.org/records/1234567/files/rainfall_2019.csv?download=1'
      )
    ).toEqual({
      site: 'zenodo',
      text: 'zenodo.1234567/rainfall_2019.csv',
      ref: null
    });
    expect(urlView('https://zenodo.org/record/1234567')).toEqual({
      site: 'zenodo',
      text: 'zenodo.1234567',
      ref: null
    });
    expect(
      urlView(
        'https://zenodo.org/api/records/1234567/files/rainfall_2019.csv/content'
      )?.text
    ).toBe('zenodo.1234567/rainfall_2019.csv');
    expect(urlView('https://doi.org/10.5281/zenodo.1234567')).toEqual({
      site: 'zenodo',
      text: 'zenodo.1234567',
      ref: null
    });
  });

  it('shows any other URL by its host and path, without the scheme', () => {
    expect(
      urlView(
        'https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/2019/01001099999.csv'
      )
    ).toEqual({
      site: 'web',
      text: 'www.ncei.noaa.gov/data/global-summary-of-the-day/access/2019/01001099999.csv',
      ref: null
    });
    // A query can hold the year, as a file name does.
    expect(
      urlView('https://api.example.org/v2/data?year=2019&country=DE')?.text
    ).toBe('api.example.org/v2/data?year=2019&country=DE');
    expect(urlView('ftp://ftp.example.org/pub/data.csv')?.text).toBe(
      'ftp.example.org/pub/data.csv'
    );
    expect(urlView('data/2019/visits.csv')).toBeNull();
  });
});

describe('the chips of URLs', () => {
  it('show the words of the URL after the name, and the URL in full in the tooltip', () => {
    const [chip] = decisionChips([download(`${THINKSTATS}first.py`, 16)]);
    expect(chip.text).toBe('url AllenDowney/ThinkStats2/code/first.py @master');
    expect(chip.url).toEqual({
      site: 'github',
      text: 'AllenDowney/ThinkStats2/code/first.py',
      ref: 'master'
    });
    expect(chip.tooltip.split('\n')[0]).toBe(`url = '${THINKSTATS}first.py'`);
  });

  it('write the folder once where calls of one function pass the files of one folder', () => {
    const chips = decisionChips([
      download(`${THINKSTATS}thinkstats2.py`, 13),
      download(`${THINKSTATS}thinkplot.py`, 14),
      download(`${THINKSTATS}2002FemPreg.dat.gz`, 20)
    ]);
    expect(chips.map(chip => chip.text)).toEqual([
      'url AllenDowney/ThinkStats2/code/thinkstats2.py @master',
      'url …/thinkplot.py',
      'url …/2002FemPreg.dat.gz'
    ]);
    // Every chip of a GitHub URL has the mark.
    expect(chips.map(chip => chip.url?.site)).toEqual([
      'github',
      'github',
      'github'
    ]);
    const zenodo = decisionChips([
      download('https://zenodo.org/records/1234567/files/a_2019.csv', 1),
      download('https://zenodo.org/records/1234567/files/b_2020.csv', 2)
    ]);
    expect(zenodo.map(chip => chip.text)).toEqual([
      'url zenodo.1234567/a_2019.csv',
      'url …/b_2020.csv'
    ]);
  });

  it('write each fork, branch and record in full', () => {
    // A fork: another owner of a repository of the same name.
    expect(
      decisionChips([
        download(`${THINKSTATS}first.py`, 1),
        download(
          'https://github.com/someone/ThinkStats2/raw/master/code/nsfg.py',
          2
        )
      ]).map(chip => chip.text)
    ).toEqual([
      'url AllenDowney/ThinkStats2/code/first.py @master',
      'url someone/ThinkStats2/code/nsfg.py @master'
    ]);
    // Two branches of one repository.
    expect(
      decisionChips([
        download(`${THINKSTATS}first.py`, 1),
        download(
          'https://github.com/AllenDowney/ThinkStats2/raw/dev/code/nsfg.py',
          2
        )
      ]).map(chip => chip.text)
    ).toEqual([
      'url AllenDowney/ThinkStats2/code/first.py @master',
      'url AllenDowney/ThinkStats2/code/nsfg.py @dev'
    ]);
    // Two records of Zenodo.
    expect(
      decisionChips([
        download('https://zenodo.org/records/1234567/files/a.csv', 1),
        download('https://zenodo.org/records/1234568/files/b.csv', 2)
      ]).map(chip => chip.text)
    ).toEqual(['url zenodo.1234567/a.csv', 'url zenodo.1234568/b.csv']);
  });

  it('draw the GitHub mark before the words of a GitHub URL, and no mark for another URL', async () => {
    const view = await mount(
      <DecisionChips
        decisions={[
          download(`${THINKSTATS}thinkstats2.py`, 1),
          {
            ...download('https://zenodo.org/records/1234567/files/a.csv', 2),
            function: 'fetch'
          }
        ]}
        onClick={() => undefined}
      />
    );
    const [github, zenodo] = Array.from(
      view.host.querySelectorAll<HTMLElement>('.jp-Epi-chip')
    );
    const mark = github.querySelector('.jp-Epi-chip-mark');
    expect(mark).not.toBeNull();
    expect(mark!.querySelector('svg')).not.toBeNull();
    expect(github.textContent).toBe(
      'url AllenDowney/ThinkStats2/code/thinkstats2.py @master'
    );
    expect(github.querySelector('.jp-Epi-chip-ref')!.textContent).toBe(
      ' @master'
    );
    expect(zenodo.querySelector('.jp-Epi-chip-mark')).toBeNull();
    expect(zenodo.textContent).toBe('url zenodo.1234567/a.csv');
    await view.unmount();
  });
});
