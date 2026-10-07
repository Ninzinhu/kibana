/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod';
import { getDashboardDataSchema } from '@kbn/as-code-dashboard-schema';
import type {
  AttachmentPanel,
  DashboardAttachmentData,
  DashboardSection,
} from '@kbn/agent-builder-dashboards-common';
import { VEGA_VIS_TYPE } from '@kbn/agent-builder-visualizations-common';
import { createDashboardValidator } from './dashboard_validator';

const validateDashboard = createDashboardValidator(
  getDashboardDataSchema({
    markdown: { schema: z.object({ content: z.string() }).strict(), title: 'Markdown' },
  })
);

const createPanel = (
  config: AttachmentPanel['config'] = { content: '# Title' },
  type = 'markdown'
): AttachmentPanel => ({
  id: 'panel',
  type,
  config,
  grid: { x: 0, y: 0, w: 24, h: 15 },
});

const createSection = (panels: AttachmentPanel[]): DashboardSection => ({
  id: 'section',
  title: 'Section',
  collapsed: false,
  grid: { y: 0 },
  panels,
});

const createDashboard = (panels: DashboardAttachmentData['panels']): DashboardAttachmentData => ({
  title: 'Dashboard',
  panels,
});

describe('createDashboardValidator', () => {
  it('returns no issues for a valid dashboard', () => {
    expect(
      validateDashboard(createDashboard([createPanel(), createSection([createPanel()])]))
    ).toEqual([]);
  });

  it('reports a panel issue from the panel option of the panel-or-section union', () => {
    expect(validateDashboard(createDashboard([createPanel({ content: 1 })]))).toEqual([
      { path: ['panels', 0, 'config', 'content'], message: expect.any(String) },
    ]);
  });

  it('reports a panel issue inside a section at the panel path', () => {
    expect(
      validateDashboard(createDashboard([createSection([createPanel({ content: 1 })])]))
    ).toEqual([
      { path: ['panels', 0, 'panels', 0, 'config', 'content'], message: expect.any(String) },
    ]);
  });

  it('reports a section issue from the section option of the panel-or-section union', () => {
    const gridWithExtraKey = { y: 0, x: 0 };
    const section = { ...createSection([]), grid: gridWithExtraKey };

    expect(validateDashboard(createDashboard([section]))).toEqual([
      { path: ['panels', 0, 'grid', 'x'], message: 'Unrecognized key' },
    ]);
  });

  it('reports one issue per unrecognized key', () => {
    expect(
      validateDashboard(createDashboard([createPanel({ content: '', size: 'l', color: 'red' })]))
    ).toEqual([
      { path: ['panels', 0, 'config', 'size'], message: 'Unrecognized key' },
      { path: ['panels', 0, 'config', 'color'], message: 'Unrecognized key' },
    ]);
  });

  it('ignores the unregistered type of vega panels, at the top level and inside sections', () => {
    const vegaPanel = createPanel({ spec: '{}' }, VEGA_VIS_TYPE);

    expect(validateDashboard(createDashboard([vegaPanel, createSection([vegaPanel])]))).toEqual([]);
  });

  it('reports the unregistered type of other panels', () => {
    expect(validateDashboard(createDashboard([createPanel({}, 'unknown')]))).toEqual([
      { path: ['panels', 0, 'type'], message: expect.any(String) },
    ]);
  });

  it('reports dashboard field issues at the field path', () => {
    expect(validateDashboard({ ...createDashboard([]), title: '' })).toEqual([
      { path: ['title'], message: expect.any(String) },
    ]);
  });
});
