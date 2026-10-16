DO $$
DECLARE
  event_type_attnum smallint;
  event_type_constraint record;
BEGIN
  SELECT attnum
  INTO event_type_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.work_order_events'::regclass
    AND attname = 'event_type'
    AND NOT attisdropped;

  FOR event_type_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.work_order_events'::regclass
      AND contype = 'c'
      AND event_type_attnum = ANY (conkey)
  LOOP
    EXECUTE format(
      'ALTER TABLE public.work_order_events DROP CONSTRAINT %I',
      event_type_constraint.conname
    );
  END LOOP;

  ALTER TABLE public.work_order_events
    ADD CONSTRAINT work_order_events_event_type_check
    CHECK (event_type IN ('start', 'pause', 'resume', 'interrupt', 'complete', 'close'));
END
$$;
