/**
 * @alveare/payments — exports publics (E6). Machine à états PUR +
 * adapters + signature des webhooks sortants. Zone Red.
 */

export {
  TRANSITIONS,
  REPEATABLE,
  canTransition,
  transition,
  IllegalTransitionError,
  type TransitionResult,
} from './state';

export {
  makePaymentProvider,
  type CheckoutInput,
  type CheckoutResult,
  type FetchStatusResult,
  type PaymentProvider,
} from './adapters';

export { makeDevProvider, devSimulate, devFetchStatus, devOutboxFile, type DevSimulateAction } from './dev';
export {
  makeChargilyProvider,
  verifyChargilyWebhook,
  chargilyApiBase,
  chargilySecretKey,
  type ChargilyOptions,
} from './chargily';

export {
  signOutbound,
  verifyOutbound,
  constantTimeHexEqual,
  webHookMaxSkewSeconds,
  type VerifyOutboundOptions,
} from './sign';
