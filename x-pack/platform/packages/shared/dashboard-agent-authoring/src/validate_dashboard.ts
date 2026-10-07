/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { get, isEqual } from 'lodash';
import type {
  AttachmentPanel,
  DashboardAttachmentData,
} from '@kbn/agent-builder-dashboards-common';
import { isSection } from '@kbn/agent-builder-dashboards-common';
import { DASHBOARD_OPERATION_FAILURE_TYPES } from './failure_types';
import type { OperationFailure } from './utils';

export interface DashboardValidationIssue {
  /** Location of the invalid value in the dashboard payload, e.g. `['panels', 0, 'config']`. */
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/**
 * Validates a whole dashboard payload against the host's dashboard schema, returning one issue per
 * invalid location (empty when the dashboard is valid).
 */
export type ValidateDashboard = (
  dashboardData: DashboardAttachmentData
) => DashboardValidationIssue[];

type DashboardField = Exclude<keyof DashboardAttachmentData, 'panels'>;

interface ValidationResult {
  dashboardData: DashboardAttachmentData;
  failures: OperationFailure[];
  /** Ids of panels that were dropped or whose content was reverted. */
  discardedPanelIds: ReadonlySet<string>;
}

type PinnedPanel = NonNullable<DashboardAttachmentData['pinned_panels']>[number];

type RevertedPanelFields = Partial<Pick<AttachmentPanel, 'type' | 'config' | 'grid'>>;

interface InvalidPanel {
  messages: string[];
  revertedFields: RevertedPanelFields;
}

interface PanelsResult {
  panels: DashboardAttachmentData['panels'];
  failures: OperationFailure[];
  discardedPanelIds: Set<string>;
}

const TOP_LEVEL_PANEL_PATH_LENGTH = 2;
const SECTION_PANEL_PATH_LENGTH = 4;
const FIELD_PATH_LENGTH = 1;

const appendTo = <TKey, TValue>(map: Map<TKey, TValue[]>, key: TKey, value: TValue) => {
  map.set(key, [...(map.get(key) ?? []), value]);
};

/** The top-level panel or section an issue path points into, if any. */
const getIssueWidget = (
  { panels }: DashboardAttachmentData,
  [location, widgetIndex]: ReadonlyArray<PropertyKey>
): DashboardAttachmentData['panels'][number] | undefined =>
  location === 'panels' && typeof widgetIndex === 'number' ? panels[widgetIndex] : undefined;

const getIssuePanel = (
  dashboardData: DashboardAttachmentData,
  path: ReadonlyArray<PropertyKey>
): { panel: AttachmentPanel; pathLength: number } | undefined => {
  const widget = getIssueWidget(dashboardData, path);
  if (!widget) {
    return undefined;
  }
  if (!isSection(widget)) {
    return { panel: widget, pathLength: TOP_LEVEL_PANEL_PATH_LENGTH };
  }
  const [, , sectionKey, panelIndex] = path;
  const sectionPanel =
    sectionKey === 'panels' && typeof panelIndex === 'number'
      ? widget.panels[panelIndex]
      : undefined;
  return sectionPanel && { panel: sectionPanel, pathLength: SECTION_PANEL_PATH_LENGTH };
};

const isDashboardField = (
  dashboardData: DashboardAttachmentData,
  key: PropertyKey | undefined
): key is DashboardField => typeof key === 'string' && key !== 'panels' && key in dashboardData;

const formatIssue = ({ path, message }: DashboardValidationIssue, locationPathLength = 0) => {
  const relativePath = path.slice(locationPathLength).map(String).join('.');
  return relativePath ? `${relativePath}: ${message}` : message;
};

/**
 * Identifies the location of an issue that cannot be attributed to a single panel or field, keying
 * section issues by section id so they still match after sections move. The message is left out
 * because it can describe the current value, e.g. the panel count.
 */
const getDashboardIssueLocation = (
  dashboardData: DashboardAttachmentData,
  { path }: DashboardValidationIssue
): string => {
  const widget = getIssueWidget(dashboardData, path);
  return widget && isSection(widget)
    ? ['section', widget.id, ...path.slice(TOP_LEVEL_PANEL_PATH_LENGTH)].map(String).join('.')
    : path.map(String).join('.');
};

const getAllPanels = (panels: DashboardAttachmentData['panels']): AttachmentPanel[] =>
  panels.flatMap((widget) => (isSection(widget) ? widget.panels : [widget]));

/**
 * Pairs each panel with the original panel it came from. Panels sharing an id are paired in
 * order, so a dashboard with duplicate ids never restores one panel from another.
 */
const getOriginalPanels = (
  originalDashboardData: DashboardAttachmentData,
  dashboardData: DashboardAttachmentData
): Map<AttachmentPanel, AttachmentPanel> => {
  const unpairedOriginalPanelsById = new Map<string, AttachmentPanel[]>();
  for (const originalPanel of getAllPanels(originalDashboardData.panels)) {
    appendTo(unpairedOriginalPanelsById, originalPanel.id, originalPanel);
  }

  const originalPanels = new Map<AttachmentPanel, AttachmentPanel>();
  for (const panel of getAllPanels(dashboardData.panels)) {
    const [originalPanel, ...otherOriginalPanels] = unpairedOriginalPanelsById.get(panel.id) ?? [];
    if (originalPanel) {
      originalPanels.set(panel, originalPanel);
      unpairedOriginalPanelsById.set(panel.id, otherOriginalPanels);
    }
  }
  return originalPanels;
};

/**
 * Whether the operations changed the value an issue points at. Compares by value, so changes are
 * detected even when operations copy unchanged content.
 */
const hasChangedValueAt = (
  panel: AttachmentPanel,
  originalPanel: AttachmentPanel | undefined,
  relativePath: ReadonlyArray<PropertyKey>
): boolean => {
  if (!originalPanel || originalPanel.type !== panel.type) {
    return true;
  }
  return relativePath.length === 0
    ? !isEqual(originalPanel, panel)
    : !isEqual(get(originalPanel, relativePath), get(panel, relativePath));
};

/**
 * The original values to restore for an issue: type and config are restored together, since the
 * config schema depends on the type, and an issue in the panel as a whole restores every field.
 */
const getRevertedFields = (
  { type, config, grid }: AttachmentPanel,
  [field]: ReadonlyArray<PropertyKey>
): RevertedPanelFields => {
  if (field === 'grid') {
    return { grid };
  }
  return field === undefined ? { type, config, grid } : { type, config };
};

const toFailure = (identifier: string, messages: string[], outcome: string): OperationFailure => ({
  type: DASHBOARD_OPERATION_FAILURE_TYPES.validateDashboard,
  identifier,
  error: `${outcome} because the result does not match the dashboard schema: ${messages.join(
    '; '
  )}`,
});

const discardInvalidPanels = ({
  originalDashboardData,
  dashboardData,
  originalPanels,
  invalidPanels,
}: {
  originalDashboardData: DashboardAttachmentData;
  dashboardData: DashboardAttachmentData;
  originalPanels: Map<AttachmentPanel, AttachmentPanel>;
  invalidPanels: Map<AttachmentPanel, InvalidPanel>;
}): PanelsResult => {
  const originalSectionIds = new Set(
    originalDashboardData.panels.filter(isSection).map(({ id }) => id)
  );
  const failures: OperationFailure[] = [];
  const discardedPanelIds = new Set<string>();

  const restorePanel = (panel: AttachmentPanel): AttachmentPanel[] => {
    const invalidPanel = invalidPanels.get(panel);
    if (!invalidPanel) {
      return [panel];
    }
    const { messages, revertedFields } = invalidPanel;

    discardedPanelIds.add(panel.id);
    const originalPanel = originalPanels.get(panel);
    if (!originalPanel) {
      failures.push(toFailure(panel.id, messages, 'Panel was not added'));
      return [];
    }

    failures.push(
      toFailure(panel.id, messages, 'Panel was reverted to its state before this call')
    );
    return [{ ...panel, ...revertedFields }];
  };

  const panels = dashboardData.panels.flatMap((widget): DashboardAttachmentData['panels'] => {
    if (!isSection(widget)) {
      return restorePanel(widget);
    }

    const sectionPanels = widget.panels.flatMap(restorePanel);
    const isNewSectionLeftEmpty =
      !originalSectionIds.has(widget.id) && widget.panels.length > 0 && sectionPanels.length === 0;
    if (isNewSectionLeftEmpty) {
      failures.push({
        type: DASHBOARD_OPERATION_FAILURE_TYPES.validateDashboard,
        identifier: widget.id,
        error: `Section "${widget.title}" was not added because none of its panels are valid.`,
      });
      return [];
    }
    return [{ ...widget, panels: sectionPanels }];
  });

  return { panels, failures, discardedPanelIds };
};

const discardInvalidFields = ({
  originalDashboardData,
  dashboardData,
  messagesByField,
  messagesByPinnedPanel,
}: {
  originalDashboardData: DashboardAttachmentData;
  dashboardData: DashboardAttachmentData;
  messagesByField: Map<DashboardField, string[]>;
  messagesByPinnedPanel: Map<PinnedPanel, string[]>;
}): Pick<ValidationResult, 'dashboardData' | 'failures'> => {
  const failures: OperationFailure[] = [];
  let nextDashboardData = dashboardData;

  if (messagesByPinnedPanel.size > 0) {
    nextDashboardData = {
      ...nextDashboardData,
      pinned_panels: dashboardData.pinned_panels?.filter(
        (pinnedPanel) => !messagesByPinnedPanel.has(pinnedPanel)
      ),
    };
    failures.push(
      toFailure(
        'pinned_panels',
        [...messagesByPinnedPanel.values()].flat(),
        'New controls were not added'
      )
    );
  }

  for (const [field, messages] of messagesByField) {
    nextDashboardData = { ...nextDashboardData, [field]: originalDashboardData[field] };
    failures.push(toFailure(field, messages, `Change to "${field}" was reverted`));
  }

  return { dashboardData: nextDashboardData, failures };
};

/**
 * Discards the changes behind validation issues so only valid writes are kept: invalid new panels
 * and items are dropped, and invalid edits get their original value back. Issues in content the
 * operations did not change are ignored, so pre-existing invalid content never blocks an update.
 * New issues that belong to no single panel or field (e.g. section or panel count issues) discard
 * every change.
 */
export const discardInvalidChanges = ({
  originalDashboardData,
  dashboardData,
  validateDashboard,
}: {
  originalDashboardData: DashboardAttachmentData;
  dashboardData: DashboardAttachmentData;
  validateDashboard: ValidateDashboard;
}): ValidationResult => {
  const issues = validateDashboard(dashboardData);
  if (issues.length === 0) {
    return { dashboardData, failures: [], discardedPanelIds: new Set() };
  }

  const originalPanels = getOriginalPanels(originalDashboardData, dashboardData);
  const invalidPanels = new Map<AttachmentPanel, InvalidPanel>();
  const messagesByField = new Map<DashboardField, string[]>();
  const messagesByPinnedPanel = new Map<PinnedPanel, string[]>();
  const dashboardIssues: DashboardValidationIssue[] = [];

  for (const issue of issues) {
    const issuePanel = getIssuePanel(dashboardData, issue.path);
    if (issuePanel) {
      const { panel, pathLength } = issuePanel;
      const originalPanel = originalPanels.get(panel);
      const relativePath = issue.path.slice(pathLength);
      if (hasChangedValueAt(panel, originalPanel, relativePath)) {
        const { messages, revertedFields } = invalidPanels.get(panel) ?? {
          messages: [],
          revertedFields: {},
        };
        invalidPanels.set(panel, {
          messages: [...messages, formatIssue(issue, pathLength)],
          revertedFields: originalPanel
            ? { ...revertedFields, ...getRevertedFields(originalPanel, relativePath) }
            : revertedFields,
        });
      }
      continue;
    }

    const [field, itemIndex] = issue.path;
    if (!isDashboardField(dashboardData, field)) {
      dashboardIssues.push(issue);
      continue;
    }

    const pinnedPanel =
      field === 'pinned_panels' && typeof itemIndex === 'number'
        ? dashboardData.pinned_panels?.[itemIndex]
        : undefined;
    if (pinnedPanel) {
      const isOriginalPinnedPanel = originalDashboardData.pinned_panels?.some(
        (originalPinnedPanel) => isEqual(originalPinnedPanel, pinnedPanel)
      );
      if (!isOriginalPinnedPanel) {
        appendTo(messagesByPinnedPanel, pinnedPanel, formatIssue(issue, FIELD_PATH_LENGTH));
      }
      continue;
    }

    if (!isEqual(dashboardData[field], originalDashboardData[field])) {
      appendTo(messagesByField, field, formatIssue(issue, FIELD_PATH_LENGTH));
    }
  }

  if (dashboardIssues.length > 0) {
    const originalIssueLocations = new Set(
      validateDashboard(originalDashboardData).map((issue) =>
        getDashboardIssueLocation(originalDashboardData, issue)
      )
    );
    const newDashboardIssues = dashboardIssues.filter(
      (issue) => !originalIssueLocations.has(getDashboardIssueLocation(dashboardData, issue))
    );
    if (newDashboardIssues.length > 0) {
      return {
        dashboardData: originalDashboardData,
        failures: [
          toFailure(
            'dashboard',
            newDashboardIssues.map((issue) => formatIssue(issue)),
            'All changes were discarded'
          ),
        ],
        discardedPanelIds: new Set(getAllPanels(dashboardData.panels).map(({ id }) => id)),
      };
    }
  }

  const panelResult = discardInvalidPanels({
    originalDashboardData,
    dashboardData,
    originalPanels,
    invalidPanels,
  });
  const fieldResult = discardInvalidFields({
    originalDashboardData,
    dashboardData,
    messagesByField,
    messagesByPinnedPanel,
  });

  return {
    dashboardData: { ...fieldResult.dashboardData, panels: panelResult.panels },
    failures: [...panelResult.failures, ...fieldResult.failures],
    discardedPanelIds: panelResult.discardedPanelIds,
  };
};
