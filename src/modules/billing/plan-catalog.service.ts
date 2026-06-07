import { Plan, type IPlan, type PlanTier } from '../../models/plan';
import { PLAN_DEFINITIONS, type PlanDefinition } from './billing.constants';

const applyOptionalStringField = (
  setFields: Record<string, unknown>,
  unsetFields: Record<string, ''>,
  key: 'paddleMonthlyPriceId' | 'paddleAnnualPriceId' | 'paddleTrialPriceId',
  value: string | undefined,
) => {
  const normalizedValue = value?.trim();
  if (normalizedValue) {
    setFields[key] = normalizedValue;
    delete unsetFields[key];
    return;
  }

  unsetFields[key] = '';
};

const buildPlanUpdate = (definition: PlanDefinition) => {
  const setFields: Record<string, unknown> = {
    name: definition.name,
    imageUploadLimit: definition.imageUploadLimit,
    alertLimit: definition.alertLimit,
    pdfEnabled: definition.pdfEnabled,
    weeklyEmailAlerts: definition.weeklyEmailAlerts,
    monthlyPrice: definition.pricing.monthly,
    annualPrice: definition.pricing.annual,
    trialDays: definition.trialDays,
  };

  const unsetFields: Record<string, ''> = {};

  applyOptionalStringField(setFields, unsetFields, 'paddleMonthlyPriceId', definition.paddleMonthlyPriceId);
  applyOptionalStringField(setFields, unsetFields, 'paddleAnnualPriceId', definition.paddleAnnualPriceId);
  applyOptionalStringField(setFields, unsetFields, 'paddleTrialPriceId', definition.paddleTrialPriceId);

  const updateDoc: Record<string, unknown> = {
    $set: setFields,
    $setOnInsert: { tier: definition.tier },
  };

  if (Object.keys(unsetFields).length > 0) {
    updateDoc.$unset = unsetFields;
  }

  return updateDoc;
};

export const syncPlanCatalogFromEnv = async (): Promise<IPlan[]> => {
  const syncedPlans = await Promise.all(
    PLAN_DEFINITIONS.map((definition) =>
      Plan.findOneAndUpdate(
        { tier: definition.tier },
        buildPlanUpdate(definition),
        { upsert: true, new: true },
      ),
    ),
  );

  console.log(`[Plan Catalog] Synced ${syncedPlans.length} plan(s) from environment.`);
  return syncedPlans;
};

export const syncPlanFromEnvByTier = async (tier: PlanTier): Promise<IPlan> => {
  const definition = PLAN_DEFINITIONS.find((planDefinition) => planDefinition.tier === tier);
  if (!definition) {
    throw new Error(`Unknown plan tier: ${tier}`);
  }

  const plan = await Plan.findOneAndUpdate(
    { tier },
    buildPlanUpdate(definition),
    { upsert: true, new: true },
  );

  if (!plan) {
    throw new Error(`Failed to sync plan tier: ${tier}`);
  }

  return plan;
};