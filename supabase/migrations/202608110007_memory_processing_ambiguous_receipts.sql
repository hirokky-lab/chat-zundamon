-- Version two was briefly used by the non-atomic compatibility claim. Any
-- pending or failed receipt left from that window has an unknown commit result
-- and must not become eligible for the atomic five-minute lease recovery.
update public.memory_processing
set processing_version = 1
where processing_version = 2
  and state in ('pending', 'failed');
