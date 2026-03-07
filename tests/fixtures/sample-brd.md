# PAMM Trading Platform

## Overview
A platform to track P&L, commissions, and referral income
for pooled PAMM trading operations.

## Business Rules
- HWM: profit calculated above previous peak only
- Commission uses slab-based percentage, not flat rate
- Referral income applies to indirect chain
- Promotional income applies to direct referrals only
- Deposit events must not trigger profit cycles

## Out of Scope
- Tax calculation or liability reporting
- Trade execution or broker integration
- Regulatory compliance checking

## Owner
Bhupesh
