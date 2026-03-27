# Boreal – Ready for Production Checklist

## Server
- [ ] All required env vars present
- [ ] Auth + OTP verified live
- [ ] Lender creation/edit works
- [ ] Application submission end-to-end
- [ ] Twilio webhooks reachable

## Staff Portal
- [ ] Portal loads without refresh loops
- [ ] Sales pipeline renders correctly
- [ ] Credit Summary visible
- [ ] Slide-in dialer opens/closes safely
- [ ] Notes are staff-only

## Client
- [ ] Application submission works
- [ ] PWA installs on mobile/desktop
- [ ] Session resumes after refresh
- [ ] Offline fallback doesn’t crash
- [ ] Redirect after submit works

## Azure
- [ ] Billing enabled
- [ ] App Services running
- [ ] Static Web Apps active
- [ ] Env vars set
- [ ] Startup Command set to `npm start`
- [ ] `WEBSITES_PORT=8080`
- [ ] `WEBSITES_CONTAINER_START_TIME_LIMIT=600`
