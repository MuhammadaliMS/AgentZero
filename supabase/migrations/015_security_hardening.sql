-- Migration 015: Security Hardening
-- Pin search_path on ALL SECURITY DEFINER functions to prevent search_path hijacking.

-- 1. Chief lease functions (already applied remotely 2026-03-06)
ALTER FUNCTION public.try_acquire_chief_lease(UUID, TEXT, INT) SET search_path = public;
ALTER FUNCTION public.release_chief_lease(UUID, TEXT) SET search_path = public;

-- 2. User/org helper functions
ALTER FUNCTION public.handle_new_user() SET search_path = public;
ALTER FUNCTION public.user_org_id() SET search_path = public;
