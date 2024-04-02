const fragments = {
  tribes: `
   bootstrapData { 
     tribes {
       id, units {
         id, carry, attackPower, upkeepCost, velocity, defencePowerAgainstInfantry, defencePowerAgainstCavalry,
         trainingCost {
           lumber, clay, iron, crop
         }
       }
     }
   }
 `,
  rallypoint: `
   ownPlayer {
     village { 
       researchedUnits {
         id level
       } 
     }
   }
 `,
  hero: `
   ownPlayer {
     hero {
       attributes {
         code, value, usedPoints
       }
       xpPercentAchievedForNextLevel,
       xpForNextLevel,
       health,
       speed,
       level,
       homeVillage { id },
       isAlive,
       inventory {
         name, typeId, id, amount
       }
       equipment {
         rightHand {
           typeId
           attributes {
             effectType value
           }
         }
         leftHand {
           typeId
           attributes {
             effectType value
           }
         }
         helmet {
           typeId
           attributes {
             effectType value
           }
         }
         body{
           typeId
           attributes {
             effectType value
           }
         }
         shoes {
           typeId
           attributes {
             effectType value
           }
         }
         horse {
           id
           typeId
           attributes {
             effectType value
           }
         }
       }
     }
   }
 `,
  troops: `
   ownPlayer {
     villages {
       id, name, x, y,
       resources {
         lumberProduction,
         clayProduction,
         ironProduction,
         netCropProduction,
         lumberStock, 
         clayStock, 
         ironStock, 
         cropStock, 
         maxStorageCapacity, 
         maxCropStorageCapacity
       }
       ownTroops {
         units {
           t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
         }
       }
       troops {
        moving  {
          edges {
            node {
              id,
              time,
              player { name id },
              scoutingTarget,
              units {
                t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
              }
              troopEvent {
                cellFrom { id, x, y, village { name } },
                cellTo { id, x, y, village { name } },
                type,
                arrivalTime
              }
            }
          }
        }
         ownTroopsAtTown {
           units {
             t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11
           }
         }
       }
     }
   }
 `,
};

export default fragments;
