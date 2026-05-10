import { generatorParameters, type FSRSParameters, type StepUnit } from "ts-fsrs";

export const FSRS_MIN_REVIEWS_FOR_OPTIMIZATION = 1000;
export const FSRS_PARAMETER_OPTIMIZATION_INTERVAL_DAYS = 30;
export const FSRS_RESCHEDULE_EXISTING_CARDS_ON_ENABLE = false;

export const FSRS_LEARNING_STEPS = ["10m"] as const satisfies readonly StepUnit[];
export const FSRS_RELEARNING_STEPS = ["10m"] as const satisfies readonly StepUnit[];

export const FSRS_SCHEDULER_CONFIG = {
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: FSRS_LEARNING_STEPS,
  relearning_steps: FSRS_RELEARNING_STEPS
} as const satisfies Partial<FSRSParameters>;

export const FSRS_PARAMETERS = generatorParameters(FSRS_SCHEDULER_CONFIG);

export const FSRS_PROJECT_CONFIG = {
  desiredRetention: FSRS_SCHEDULER_CONFIG.request_retention,
  minReviewsForOptimization: FSRS_MIN_REVIEWS_FOR_OPTIMIZATION,
  parameterOptimizationIntervalDays: FSRS_PARAMETER_OPTIMIZATION_INTERVAL_DAYS,
  rescheduleExistingCardsOnEnable: FSRS_RESCHEDULE_EXISTING_CARDS_ON_ENABLE,
  learningSteps: FSRS_LEARNING_STEPS,
  relearningSteps: FSRS_RELEARNING_STEPS
} as const;
