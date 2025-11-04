<!--App.vue-->
<script setup>
// --- 這整個 SCRIPT 區塊完全沒動 ---
import {ref, computed, onMounted, watch} from 'vue';
import axios from 'axios';
import {auth} from './firebase';
import {onAuthStateChanged, onIdTokenChanged, signOut} from 'firebase/auth';

const isLoading = ref(false);

(async () => {
  const u = auth.currentUser;
  if (u) {
    const t = await u.getIdToken();
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
  }
})();

onIdTokenChanged(auth, async (user) => {
  if (user) {
    const t = await user.getIdToken(/* forceRefresh */ true);
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
});

axios.interceptors.request.use(
    (config) => {
      isLoading.value = true;
      return config;
    },
    (error) => {
      isLoading.value = false;
      return Promise.reject(error);
    }
);

axios.interceptors.response.use(
    (response) => {
      isLoading.value = false;
      return response;
    },
    (error) => {
      isLoading.value = false;
      return Promise.reject(error);
    }
);

import AuthAndCreate from './components/AuthAndCreate.vue';
import ItineraryManager from './components/ItineraryManager.vue';
import ProfileCard from './components/ProfileCard.vue';

const isAuthenticated = ref(false);
const userEmail = ref(null);
const refreshKey = ref(0);
const viewEmail = ref(null);

async function applyAuthHeader(user) {
  if (!user) {
    delete axios.defaults.headers.common['Authorization'];
    return;
  }
  const token = await user.getIdToken();
  axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
}

function syncViewEmailFromURL() {
  const params = new URLSearchParams(window.location.search);
  const qEmail = params.get('profile');

  if (qEmail && qEmail.includes('@')) {
    viewEmail.value = qEmail;
  } else {
    viewEmail.value = userEmail.value;
  }
}

function goHome() {
  window.location.href = '/';
}

function handleItineraryUpdate() {
  refreshKey.value++;
}

async function handleLogout() {
  await signOut(auth);
}

const effectiveEmail = computed(() => viewEmail.value || userEmail.value || '');

const isViewingSomeoneElse = computed(() => {
  return (
      userEmail.value &&
      effectiveEmail.value &&
      userEmail.value !== effectiveEmail.value
  );
});

function handleNoData() {
  if (isViewingSomeoneElse.value) {
    alert("This user has no trips or does not exist. Returning to homepage.");
    window.location.href = "/";
  }
}

onMounted(() => {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      isAuthenticated.value = true;
      userEmail.value = user.email || null;
      await applyAuthHeader(user);

// <-- 把它加回來 -->
      try {
        await axios.post(`${import.meta.env.VITE_API_BASE_URL}/api/travellers/ensure`, {
          name: user.displayName || 'New User'
        });
      } catch (err) {
        console.error("Failed to ensure user in DB:", err);
      }
      // <-- FIX ENDED -->

      localStorage.setItem('tripplanner_userEmail', userEmail.value || '');

      localStorage.setItem('tripplanner_userEmail', userEmail.value || '');
    } else {
      isAuthenticated.value = false;
      userEmail.value = null;
      await applyAuthHeader(null);
      localStorage.removeItem('tripplanner_userEmail');
    }
    syncViewEmailFromURL();
  });

  syncViewEmailFromURL();
});

watch(userEmail, () => {
  const params = new URLSearchParams(window.location.search);
  const qEmail = params.get('profile');
  if (!qEmail) {
    viewEmail.value = userEmail.value;
  }
});

// <--
// 1. NEW:
// 監聽 isLoading 的變化
// -->
watch(isLoading, (newValue) => {
  if (newValue) {
    // 轉圈時，鎖住 <html> 的捲動
    document.documentElement.classList.add('is-loading');
  } else {
    // 轉完時，解鎖
    document.documentElement.classList.remove('is-loading');
  }
});
// <-- NEW BLOCK ENDED -->

</script>

<template>
  <div class="loading-overlay" v-if="isLoading">
    <div class="loading-box">


  <div v-if="isLoading" class="loading-overlay">
    <div class="cupertino-spinner">
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
      <div></div>
    </div>
  </div>
</div>
  </div>
  <div class="min-h-screen bg-gray-100">
    <header v-if="!isLoading"
            class="bg-indigo-600 text-white
               py-3 px-2 rounded-lg shadow-lg mb-4
               flex justify-between items-center
               sticky top-2" style="z-index: 9999;">
      <h1 class="text-2xl font-bold flex items-center space-x-2 ">
        <strong><span><a href="/" style="color:white">DragonFlyX</a></span></strong>
        <span
            v-if="isAuthenticated && isViewingSomeoneElse"
            class="text-xs font-normal bg-white/20 rounded px-2 py-0.5"
        >
          viewing {{ effectiveEmail }}
        </span>
      </h1>
      <div v-if="userEmail" class="flex items-center space-x-3">
        <p class="text-sm">{{ userEmail }}</p>
        <button
            @click="handleLogout"
            class="py-1 px-3 bg-red-400 text-white text-sm font-semibold rounded-md hover:bg-red-500 transition shadow-sm z-9997"
        >
          Logout
        </button>
      </div>
    </header>
    <header v-if="isLoading"
            class="bg-indigo-600 text-white
               py-3 px-2 rounded-lg shadow-lg mb-4
               flex justify-between items-center
               sticky top-2" style="z-index: 9999;cursor: wait;">
      <h1 class="text-2xl font-bold flex items-center space-x-2 ">
        <strong><span><a style="color:white">DragonFlyX</a></span></strong>
      </h1>
      <div class="flex items-center space-x-3">
        <h1 class="text-2xl font-bold flex items-center space-x-2 ">
          <strong><span><a style="color:white">🐲 🚁</a></span></strong>
        </h1>
      </div>
    </header>
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto">
      <div v-if="!isAuthenticated" class="lg:col-span-12">
        <div class="lg:col-span-12 space-y-6">
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 class="text-2xl font-bold mb-1 text-gray-800 text-center">🐲 DragonFlyX 🚁</h2>
            <div class="space-y-1 text-gray-700"><p><strong>The Trip Planner.</strong></p></div>
            <br>
            <div class="space-y-1 text-gray-700 text-center md:text-left">
              <p><strong>Team name:</strong> <span class="text-indigo-600">Kenting 🏖️</span></p>
              <p><strong>Team member:</strong> Po-Chun Lu</p>
              <p><strong>Professor:</strong> Dr. Markus Eilsperger</p>
            </div>
          </div>
          <AuthAndCreate @set-loading="isLoading = $event"/>
        </div>
      </div>
      <template v-else>
        <div class="lg:col-span-5 space-y-6">
          <div class="bg-white p-4 rounded-xl shadow-lg border border-gray-200">
            <h2 class="text-2xl font-bold mb-1 text-gray-800 text-center">🐲 DragonFlyX 🚁</h2>
            <div class="space-y-1 text-gray-700"><p><strong>The Trip Planner.</strong></p></div>
            <br>
            <div class="space-y-1 text-gray-700 text-center md:text-left">
              <p><strong>Team name:</strong> <span class="text-indigo-600">Kenting 🏖️</span></p>
              <p><strong>Team member:</strong> Po-Chun Lu</p>
              <p><strong>Professor:</strong> Dr. Markus Eilsperger</p>
            </div>
          </div>
          <ProfileCard
              :userEmail="effectiveEmail"
              :currentUserEmail="userEmail"
          />
          <AuthAndCreate
              v-if="!isViewingSomeoneElse"
              :userEmail="userEmail"
              :isAuthenticated="isAuthenticated"
              @itinerary-updated="handleItineraryUpdate"
              @set-loading="isLoading = $event"
          />
          <div
              v-else
              class="bg-yellow-50 text-yellow-800 text-sm rounded-xl border border-yellow-300 shadow p-6"
          >
            <p class="font-semibold text-yellow-700 text-center">
              Viewing {{ effectiveEmail }}'s trips
            </p>
            <button
                class="mt-4 w-full py-2 px-4 bg-yellow-400 text-black font-semibold rounded-md hover:bg-yellow-500 transition shadow-sm"
                @click="goHome"
            >
              Go to Homepage
            </button>
          </div>
        </div>
        <div class="lg:col-span-7 space-y-3">
          <ItineraryManager
              :travellerEmail="effectiveEmail"
              :currentUserEmail="userEmail"
              :refreshSignal="refreshKey"
              @no-data="handleNoData"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style>
html.is-loading {
  overflow: hidden;
}
</style>

<style scoped>

/* 3. FIX:
  拿掉 'overflow: hidden;' 和 'touch-action: none;'
  因為它們現在改由上面的 global style (html.is-loading) 控制
*/
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none; /* 防止擋到背景操作（可選） */
}

/* 中間毛玻璃區塊 */
.loading-box {
  background-color: rgba(0,0,0, 0.5);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(5px);
  border-radius: 20px;
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
  padding: 5rem 5rem;
  pointer-events: all; /* 如果裡面有 spinner 或文字，讓它能互動 */
}


/* --- (剩下的 .cupertino-spinner 樣式完全不變) --- */
.cupertino-spinner {
  /* FIX: 40px -> 60px (更大) */
  width: 60px;
  height: 60px;
  position: relative;
}

.cupertino-spinner div {
  position: absolute;
  /* FIX: 更粗 (4px), 更長 (15px) */
  width: 4px;
  height: 15px;

  /* 輻條的樣式 */
  background-color: #ffffff;
  border-radius: 2px; /* 4px / 2 */

  /* 定位:
    left: (60px / 2) - (4px / 2) = 28px
    top:  (設定一個 5px 的內距, 讓它不在最邊緣)
  */
  left: 28px;
  top: 5px;

  /* 旋轉中心點 (關鍵):
    X 軸: 輻條寬度一半 (4px / 2) = 2px
    Y 軸: Spinner 高度一半 - 頂部內距 (60px / 2) - 5px = 25px
  */
  transform-origin: 2px 25px;

  opacity: 0;
  animation: spinner-fade 1s linear infinite;
}

/* @keyframes 保持不變 (一樣是淡入淡出) */
@keyframes spinner-fade {
  from {
    opacity: 0.85;
  }
  to {
    opacity: 0.15;
  }
}

/* FIX: 12 根 (30deg) -> 8 根 (45deg)
  Delay 也從 1/12 (0.0833s) 改成 1/8 (0.125s)
*/
.cupertino-spinner div:nth-child(1) {
  transform: rotate(0deg);
  animation-delay: -0.875s; /* -7/8 s */
}

.cupertino-spinner div:nth-child(2) {
  transform: rotate(45deg);
  animation-delay: -0.75s; /* -6/8 s */
}

.cupertino-spinner div:nth-child(3) {
  transform: rotate(90deg);
  animation-delay: -0.625s; /* -5/8 s */
}

.cupertino-spinner div:nth-child(4) {
  transform: rotate(135deg);
  animation-delay: -0.5s; /* -4/8 s */
}

.cupertino-spinner div:nth-child(5) {
  transform: rotate(180deg);
  animation-delay: -0.375s; /* -3/8 s */
}

.cupertino-spinner div:nth-child(6) {
  transform: rotate(225deg);
  animation-delay: -0.25s; /* -2/8 s */
}

.cupertino-spinner div:nth-child(7) {
  transform: rotate(270deg);
  animation-delay: -0.125s; /* -1/8 s */
}

.cupertino-spinner div:nth-child(8) {
  transform: rotate(315deg);
  animation-delay: 0s; /* 0/8 s */
}
</style>