-- If a superseded capability is purged, retain the surviving card's lifecycle state and
-- history while clearing only its now-missing link to the deleted capability.
ALTER TABLE caphub_v2.capabilities
  DROP CONSTRAINT capabilities_superseded_by_fkey;

ALTER TABLE caphub_v2.capabilities
  ADD CONSTRAINT capabilities_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES caphub_v2.capabilities(id) ON DELETE SET NULL;
