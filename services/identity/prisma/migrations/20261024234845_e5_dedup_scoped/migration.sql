/*
  Revue N5-1 : dedupKey unique GLOBAL → unique scoppé par app émettrice.
  Deux apps peuvent librement choisir la même clé sans collision frauduleuse.
*/
DROP INDEX IF EXISTS "notify"."Notification_dedupKey_key";
CREATE UNIQUE INDEX "Notification_via_dedupKey_key" ON "notify"."Notification"("via", "dedupKey");
