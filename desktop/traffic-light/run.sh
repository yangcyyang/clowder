#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .build
swiftc TrafficLightStatus.swift TrafficLightApp.swift -o .build/ClowderTrafficLight
exec ./.build/ClowderTrafficLight
