/**
 * Questions about the rows of a range picked on a plot (design iteration
 * 1.85). Pain step 28: weeks 20 to 28 picked on the trajectory of pain
 * asked only about the interval method of the card.
 */
import { groupOf, rowsQuestions } from '../model/regionrows';

const COLUMNS = [
  { label: 'patient_id', kind: 'id', unique: 318 },
  { label: 'week', kind: 'numeric', unique: 28 },
  { label: 'pain', kind: 'numeric', unique: 11 },
  { label: 'site', kind: 'categorical', unique: 3 },
  { label: 'treatment_arm', kind: 'binary', unique: 2 },
  { label: 'notes', kind: 'text', unique: 900 }
];

describe('the rows of a range on a plot', () => {
  it('compares the groups of the plot, else a column named as a group, else a column of a few levels', () => {
    expect(groupOf('tariff', COLUMNS, [])).toBe('tariff');
    expect(groupOf(null, COLUMNS, ['week', 'pain', 'patient_id'])).toBe(
      'treatment_arm'
    );
    expect(
      groupOf(
        null,
        COLUMNS.filter(column => column.label !== 'treatment_arm'),
        []
      )
    ).toBe('site');
    expect(groupOf(null, COLUMNS.slice(0, 3), [])).toBe(null);
  });

  it('asks who is in the rows and how the groups compare there, one mean per patient', () => {
    const mask = 'diary_patients["week"].between(20, 28)';
    const [who, groups] = rowsQuestions({
      frame: 'diary_patients',
      mask,
      where: '20 <= week <= 28',
      y: 'pain',
      unit: 'patient_id',
      group: 'treatment_arm',
      placement: { kind: 'new', cell: 'c5', label: 'new cell after [5]' },
      key: '20:28:'
    });
    expect(who.text).toBe('Who is in these rows?');
    expect(who.code).toBe(
      [
        '# Who is in the rows of diary_patients where 20 <= week <= 28?',
        'import whybook',
        '',
        `whybook.who_is_in(diary_patients, ${mask}, unit="patient_id")`
      ].join('\n')
    );
    expect(groups.text).toBe(
      'How do the groups of treatment_arm compare here?'
    );
    expect(groups.code).toContain(
      `whybook.compare_levels(diary_patients[${mask}], "pain", "treatment_arm", unit="patient_id")`
    );
    // Without a y or a column of groups, only who is in the rows.
    expect(
      rowsQuestions({
        frame: 'readings',
        mask: 'readings["kwh_import"].between(0, 5)',
        where: '0 <= kwh_import <= 5',
        y: null,
        unit: null,
        group: null,
        placement: { kind: 'new', cell: 'c1', label: 'new cell after [1]' },
        key: '0:5:'
      }).map(question => question.text)
    ).toEqual(['Who is in these rows?']);
  });
});
