<!-- frontend-vue/src/App.vue -->
<script setup>
import AuthAndCreate from './components/AuthAndCreate.vue';
import ItineraryManager from './components/ItineraryManager.vue';
import ProfileCard from './components/ProfileCard.vue';
import { ref, computed, onMounted, watch } from 'vue';
import axios from 'axios';
import { auth } from './firebase';
import { onAuthStateChanged, onIdTokenChanged, signOut } from 'firebase/auth';

// 初始化：若已登入，先帶一次 token
(async () => {
  const u = auth.currentUser;
  if (u) {
    const t = await u.getIdToken();
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
  }
})();

// 之後只要 token 變動，就更新 header
onIdTokenChanged(auth, async (user) => {
  if (user) {
    const t = await user.getIdToken(/* forceRefresh */ true);
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
});

// 狀態
const isAuthenticated = ref(false);
const userEmail = ref(null);
const refreshKey = ref(0);

// 正在觀看的目標使用者 (自己 or 別人)
const viewEmail = ref(null);

// 將 Firebase ID Token 設到 axios Authorization header
async function applyAuthHeader(user) {
  if (!user) {
    delete axios.defaults.headers.common['Authorization'];
    return;
  }
  const token = await user.getIdToken();
  axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
}

// 從網址讀 ?profile=<email>
function syncViewEmailFromURL() {
  const params = new URLSearchParams(window.location.search);
  const qEmail = params.get('profile'); // 統一用 'profile'

  if (qEmail && qEmail.includes('@')) {
    viewEmail.value = qEmail; // 看別人
  } else {
    viewEmail.value = userEmail.value; // 看自己
  }
}

function goHome() {
  window.location.href = '/';
}

// 新增/編輯行程後刷新右邊列表
function handleItineraryUpdate() {
  refreshKey.value++;
}

// 登出
async function handleLogout() {
  await signOut(auth);
}

// 畫面上實際顯示的 email (誰的卡 & 誰的行程)
const effectiveEmail = computed(() => viewEmail.value || userEmail.value || '');

// 我是不是在看別人
const isViewingSomeoneElse = computed(() => {
  return (
      userEmail.value &&
      effectiveEmail.value &&
      userEmail.value !== effectiveEmail.value
  );
});

// ItineraryManager 回報「這個 user 沒行程/不存在」
function handleNoData() {
  if (isViewingSomeoneElse.value) {
    alert("This user has no trips or does not exist. Returning to homepage.");
    window.location.href = "/";
  }
}

// 監聽 Firebase Auth 狀態
onMounted(() => {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      isAuthenticated.value = true;
      userEmail.value = user.email || null;
      await applyAuthHeader(user);
      localStorage.setItem('tripplanner_userEmail', userEmail.value || '');
    } else {
      isAuthenticated.value = false;
      userEmail.value = null;
      await applyAuthHeader(null);
      localStorage.removeItem('tripplanner_userEmail');
    }
    syncViewEmailFromURL();
  });

  // 首次載入也同步一下 URL
  syncViewEmailFromURL();
});

// 如果登入了，而且網址沒有指定 profile，就把 viewEmail 綁回自己
watch(userEmail, () => {
  const params = new URLSearchParams(window.location.search);
  const qEmail = params.get('profile');
  if (!qEmail) {
    viewEmail.value = userEmail.value;
  }
});
</script>

<template>
  <div class="min-h-screen bg-gray-100 p-1 md:p-2">
    <!-- Header -->
    <header class="bg-indigo-600 text-white p-2 rounded-lg shadow-lg mb-4 flex justify-between items-center">
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
            class="py-1 px-3 bg-red-400 text-white text-sm font-semibold rounded-md hover:bg-red-500 transition shadow-sm"
        >
          Logout
        </button>
      </div>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto">
      <!-- 未登入狀態 -->
      <div v-if="!isAuthenticated" class="lg:col-span-12">
        <div class="lg:col-span-12 space-y-6">
          <!-- Info Card -->
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 class="text-2xl font-bold mb-4 text-gray-800">DragonFlyX</h2>
            <div class="space-y-1 text-gray-700">
              <p><strong>Team name:</strong> <span class="text-indigo-600">Kenting 🏖️</span></p>
              <p><strong>Team member:</strong> Po-Chun Lu</p>
              <p><strong>Professor:</strong> Dr. Markus Eilsperger</p>
            </div>
          </div>

          <!-- Login/Register -->
          <AuthAndCreate />
        </div>
      </div>

      <!-- 登入後畫面 -->
      <template v-else>
        <!-- 左側 -->
        <div class="lg:col-span-5 space-y-6">
          <!-- Info card -->
          <div class="bg-white p-4 rounded-xl shadow-lg border border-gray-200">
            <h2 class="text-2xl font-bold mb-1 text-gray-800 text-center">🐲 DragonFlyX 🚁</h2>
            <div class="space-y-1 text-gray-700"><p><strong>The Trip Planner.</strong></p></div><br>
            <div class="space-y-1 text-gray-700 text-center md:text-left">
              <p><strong>Team name:</strong> <span class="text-indigo-600">Kenting 🏖️</span></p>
              <p><strong>Team member:</strong> Po-Chun Lu</p>
              <p><strong>Professor:</strong> Dr. Markus Eilsperger</p>
            </div>
          </div>

          <!-- 如果是自己 -> 顯示建立新行程表單 -->
          <AuthAndCreate
              v-if="!isViewingSomeoneElse"
              :userEmail="userEmail"
              :isAuthenticated="isAuthenticated"
              @itinerary-updated="handleItineraryUpdate"
          />

          <!-- 如果在看別人 -> 顯示提醒卡 -->
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

        <!-- 右側 -->
        <div class="lg:col-span-7 space-y-4">
          <ProfileCard
              :userEmail="effectiveEmail"
              :currentUserEmail="userEmail"
          />

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