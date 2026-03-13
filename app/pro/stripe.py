from __future__ import annotations

import os
import logging

import stripe
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..core.db import find_user_by_stripe_customer, get_user, update_user_tier

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pro", tags=["pro"])

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID", "").strip()
APP_URL = os.getenv("APP_URL", "https://feynman-pro.vercel.app").strip()

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

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "checkout.session.completed":
        user_id = data.get("metadata", {}).get("user_id")
        customer_id = data.get("customer")
        subscription_id = data.get("subscription")
        if user_id:
            update_user_tier(user_id, "pro", customer_id, subscription_id)
            log.info("User %s upgraded to pro via checkout", user_id)

    elif event_type == "customer.subscription.updated":
        customer_id = data.get("customer")
        status = data.get("status")
        user = find_user_by_stripe_customer(customer_id) if customer_id else None
        if user:
            tier = "pro" if status == "active" else "free"
            update_user_tier(str(user["id"]), tier)
            log.info("Subscription updated for user %s: %s", user["id"], tier)

    elif event_type == "customer.subscription.deleted":
        customer_id = data.get("customer")
        user = find_user_by_stripe_customer(customer_id) if customer_id else None
        if user:
            update_user_tier(str(user["id"]), "free")
            log.info("Subscription cancelled for user %s", user["id"])

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
