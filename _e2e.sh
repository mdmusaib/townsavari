#!/bin/bash
set -u
node "$(dirname "$0")/_e2e_reset.js"
B=http://localhost:5001/api/v1
RIDER=RIDER_E2E
DA=DRIVER_E2E_A
DB=DRIVER_E2E_B
PASS=0; FAIL=0
ok(){ if [ "$1" = "$2" ]; then echo "PASS: $3"; PASS=$((PASS+1)); else echo "FAIL: $3 (got '$1' want '$2')"; FAIL=$((FAIL+1)); fi; }
post(){ curl -s -X POST "$B/$1" -H 'Content-Type: application/json' --data "$2"; }
get(){ curl -s "$B/$1"; }

# --- payloads built in variables (avoids bash brace-expansion pitfalls) ---
P_STATUS_A=$(printf '{"driverId":"%s","isOnline":true,"lat":13.0827,"lng":80.2707}' "$DA")
P_STATUS_B=$(printf '{"driverId":"%s","isOnline":true,"lat":13.0850,"lng":80.2750}' "$DB")
P_FCM_R=$(printf '{"userId":"%s","token":"e2e-rider-token","role":"RIDER"}' "$RIDER")
P_REQ=$(printf '{"riderId":"%s","pickup":{"lat":13.0827,"lng":80.2707},"dropoff":{"lat":13.1000,"lng":80.2900}}' "$RIDER")

post driver/status "$P_STATUS_A" >/dev/null
post driver/status "$P_STATUS_B" >/dev/null
ok "$(get "drivers/$DA" | jq -r .isOnline)" "true" "driver A is online"

ok "$(post users/fcm-token "$P_FCM_R" | jq -r .ok)" "true" "rider fcm token saved"

RIDE=$(post rides/request "$P_REQ")
RID=$(echo "$RIDE" | jq -r .id)
FARE=$(echo "$RIDE" | jq -r .fare)
ok "$(echo "$RIDE" | jq -r .status)" "REQUESTED" "ride created in REQUESTED"
echo "     rideId=$RID fare=$FARE distanceKm=$(echo "$RIDE" | jq -r .distanceKm) source=$(echo "$RIDE" | jq -r .distanceSource)"

ok "$(get "driver/available-rides?driverId=$DA" | jq --arg r "$RID" '[.rides[].id]|index($r)!=null')" "true" "ride offered to driver A"

P_REJ_A=$(printf '{"rideId":"%s","driverId":"%s"}' "$RID" "$DA")
post rides/reject "$P_REJ_A" >/dev/null
ok "$(get "driver/available-rides?driverId=$DA" | jq --arg r "$RID" '[.rides[].id]|index($r)==null')" "true" "rejected ride hidden from driver A"
ok "$(get "driver/available-rides?driverId=$DB" | jq --arg r "$RID" '[.rides[].id]|index($r)!=null')" "true" "ride still offered to driver B"

P_ACC_A=$(printf '{"rideId":"%s","driverId":"%s"}' "$RID" "$DA")
P_ACC_B=$(printf '{"rideId":"%s","driverId":"%s"}' "$RID" "$DB")
C1=$(curl -s -o /tmp/accA.json -w '%{http_code}' -X POST "$B/rides/accept" -H 'Content-Type: application/json' --data "$P_ACC_A")
C2=$(curl -s -o /tmp/accB.json -w '%{http_code}' -X POST "$B/rides/accept" -H 'Content-Type: application/json' --data "$P_ACC_B")
CODES=$(printf '%s\n%s' "$C1" "$C2" | sort | tr '\n' ',')
ok "$CODES" "200,409," "concurrent accept yields one 200 and one 409"
WINNER=$(jq -r '.driverId // empty' /tmp/accA.json); [ -z "$WINNER" ] && WINNER=$(jq -r .driverId /tmp/accB.json)
echo "     winner=$WINNER"

P_ARR=$(printf '{"rideId":"%s","driverId":"%s"}' "$RID" "$WINNER")
P_STR=$(printf '{"rideId":"%s","driverId":"%s"}' "$RID" "$WINNER")
ok "$(post rides/arrived "$P_ARR" | jq -r .status)" "ARRIVED" "arrived transition"
ok "$(post rides/start "$P_STR" | jq -r .status)" "IN_PROGRESS" "start transition"
ok "$(post rides/arrived "$P_ARR" | jq -r .error | grep -c 'cannot move')" "1" "illegal re-arrive rejected"

P_CMP=$(printf '{"rideId":"%s","driverId":"%s","amountCollected":%s}' "$RID" "$WINNER" "$FARE")
COMP=$(post rides/complete "$P_CMP")
ok "$(echo "$COMP" | jq -r .status)" "COMPLETED" "ride completed"
EXPECT_COMM=$(python3 -c "print(round($FARE*0.10,2))")
ok "$(echo "$COMP" | jq -r .commissionCharged)" "$EXPECT_COMM" "commission charged = 10% of fare"
ok "$(echo "$COMP" | jq -r .driverCommissionOwed)" "$EXPECT_COMM" "driver commissionOwed updated"
REPLAY=$(post rides/complete "$P_CMP")
ok "$(echo "$REPLAY" | jq -r .alreadyCompleted)" "true" "replay is idempotent"
ok "$(echo "$REPLAY" | jq -r .commissionCharged)" "0" "replay charges no extra commission"

P_CP=$(printf '{"rideId":"%s","riderId":"%s"}' "$RID" "$RIDER")
P_RATE=$(printf '{"rideId":"%s","riderId":"%s","rating":5,"comment":"e2e"}' "$RID" "$RIDER")
ok "$(post rides/confirm-payment "$P_CP" | jq -r .paymentStatus)" "PAID" "rider confirms cash payment"
ok "$(post rides/rate "$P_RATE" | jq -r .ok)" "true" "rider rating saved"

ok "$(get "rider/history?riderId=$RIDER" | jq --arg r "$RID" '[.rides[].id]|index($r)!=null')" "true" "ride in rider history"
STATS=$(get "driver/stats?driverId=$WINNER")
ok "$(echo "$STATS" | jq -r '.completedRides>=1')" "true" "driver stats counts completed ride"
ok "$(echo "$STATS" | jq -r .commissionOwed)" "$EXPECT_COMM" "driver stats commissionOwed"

echo "-----------------------------------------"
echo "RESULT: PASS=$PASS FAIL=$FAIL RIDE=$RID WINNER=$WINNER"
( exit $FAIL )
