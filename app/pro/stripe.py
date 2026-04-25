from __future__ import annotations

import os
import logging

import stripe
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..core.db import (
    clear_stripe_webhook,
    get_user,
    mark_stripe_webhook_processed,
    update_user_tier,
    update_user_tier_by_stripe_customer,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pro", tags=["pro"])

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID", "").strip()
APP_URL = os.getenv("APP_URL", "https://feynman.wiki").strip()

stripe.api_key = STRIPE_SECRET_KEY


@router.post("/create-checkout-session")
async def create_checkout_session(request: Request):
    user_id = getattr(request.state, "user_id", None)
    email = getattr(request.state, "email", "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    if not STRIPE_SECRET_KEY or not STRIPE_PRICE_ID:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    user = get_user(user_id)
    customer_id = user.get("stripe_customer_id") if user else None

    try:
        session_params = {
            "mode": "subscription",
            "line_items": [{"price": STRIPE_PRICE_ID, "quantity": 1}],
            "success_url": f"{APP_URL}/#/subscription?success=true",
            "cancel_url": f"{APP_URL}/#/subscription?canceled=true",
            "metadata": {"user_id": user_id},
        }
        if customer_id:
            session_params["customer"] = customer_id
        else:
            session_params["customer_email"] = email

        session = stripe.checkout.Session.create(**session_params)
        return {"url": session.url}
    except stripe.error.StripeError as e:
        log.error("Stripe checkout error: %s", e)
        raise HTTPException(status_code=500, detail="Payment initialization failed")


@router.post("/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Webhook not configured")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    event_id = event.get("id") or ""
    event_type = event["type"]
    data = event["data"]["object"]

    # Idempotency guard: Stripe re-delivers events on its own retry policy and
    # may also deliver the same event twice during transient failures. Without
    # this, checkout.session.completed running twice overwrites timestamps and
    # subscription.deleted replays could downgrade a re-subscribed user.
    if event_id and not mark_stripe_webhook_processed(event_id):
        log.info("Stripe webhook %s (%s) already processed, skipping", event_id, event_type)
        return JSONResponse({"status": "ok", "duplicate": True})

    try:
        if event_type == "checkout.session.completed":
            user_id = data.get("metadata", {}).get("user_id")
            customer_id = data.get("customer")
            subscription_id = data.get("subscription")
            if user_id:
                update_user_tier(user_id, "pro", customer_id, subscription_id,
                                 subscription_status="active")
                log.info("User %s upgraded to pro via checkout", user_id)

        elif event_type == "customer.subscription.updated":
            customer_id = data.get("customer")
            status = data.get("status")
            if customer_id:
                tier = "pro" if status in ("active", "trialing") else "free"
                ended_at = None
                if status in ("canceled", "unpaid", "past_due"):
                    from datetime import datetime, timezone
                    ended_at = datetime.now(timezone.utc).isoformat()
                user = update_user_tier_by_stripe_customer(
                    customer_id,
                    tier=tier,
                    subscription_status=status,
                    subscription_ended_at=ended_at,
                )
                if user:
                    log.info("Subscription updated for user %s: status=%s tier=%s", user["id"], status, tier)

        elif event_type == "customer.subscription.deleted":
            customer_id = data.get("customer")
            if customer_id:
                from datetime import datetime, timezone
                ended_at = datetime.now(timezone.utc).isoformat()
                user = update_user_tier_by_stripe_customer(
                    customer_id,
                    tier="free",
                    subscription_status="canceled",
                    subscription_ended_at=ended_at,
                )
                if user:
                    log.info("Subscription cancelled for user %s", user["id"])
    except Exception:
        # Roll back the idempotency record so Stripe's retry can re-process.
        if event_id:
            clear_stripe_webhook(event_id)
        raise

    return JSONResponse({"status": "ok"})


@router.post("/create-portal-session")
async def create_portal_session(request: Request):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = get_user(user_id)
    customer_id = user.get("stripe_customer_id") if user else None
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription")

    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{APP_URL}/#/subscription",
        )
        return {"url": session.url}
    except stripe.error.StripeError as e:
        log.error("Stripe portal error: %s", e)
        raise HTTPException(status_code=500, detail="Portal session failed")
